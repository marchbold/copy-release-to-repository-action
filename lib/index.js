const core = require("@actions/core");
const github = require("@actions/github");
const { retry } = require("@octokit/plugin-retry");
const { GitHub, getOctokitOptions } = require("@actions/github/lib/utils");
const fetch = require("node-fetch");

const fs = require("fs");
const { create } = require("domain");

const triggerEventName = process.env.GITHUB_EVENT_NAME;
const eventPath = require(process.env.GITHUB_EVENT_PATH);

const getOrCreateRelease = async (octo, { tag, repoOrgName, releaseData }) => {
  const [destRepoOwner, destRepoName] = repoOrgName.split("/");
  var { data: destReleases } = await octo.rest.repos.listReleases({
    owner: destRepoOwner,
    repo: destRepoName,
  });

  const existingRelease = destReleases.find((r) => r.tag_name === tag);
  if (existingRelease) {
    // TODO: update
    return existingRelease;
  }

  const createReleaseData = {
    body: releaseData.body,
    name: releaseData.name,
    draft: releaseData.draft,
    prerelease: releaseData.prerelease,
    owner: destRepoOwner,
    repo: destRepoName,
    tag_name: tag,
  };

  const { data: createRelease } = await octo.rest.repos.createRelease(
    createReleaseData
  );

  return createRelease;
};

async function run() {
  try {
    const sourceRepo = core.getInput("source_repo", { required: true });
    const destRepo = core.getInput("destination_repo", { required: true });
    const ref = core.getInput("tag") || process.env.GITHUB_REF;
    const gitHubKey =
      process.env.GITHUB_TOKEN ||
      core.getInput("github_token", { required: true });
    const [owner, repo] = sourceRepo.split("/"); 
    
    const payload = JSON.stringify(github.context.payload, undefined, 2);

    console.log(process.env.GITHUB_REF);
    console.log(`The event payload: ${payload}`);
    console.log(destRepo);
    console.log(triggerEventName);
    console.log(eventPath);
    console.log(owner);
    console.log(repo);

    // Handle refs/tags/tag
    const [tag, ...rest] = ref.split("/").reverse();

    const octokit = GitHub.plugin(retry);
    const octo = new octokit(getOctokitOptions(gitHubKey));

    // Get the source release
    const { data: sourceRelease } = await octo.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });

    if (sourceRelease.draft || sourceRelease.prerelease) return;

    // Create / get a matching destination release
    const destRelease = await getOrCreateRelease(octo, {
      tag,
      repoOrgName: destRepo,
      releaseData: sourceRelease,
    });

    console.log(sourceRelease);
    console.log(destRelease);

    // Copy assets
    const [destRepoOwner, destRepoName] = destRepo.split("/");
    const assetPromises = sourceRelease.assets.map(async (asset) => {
      const { url: assetUrl } = await octo.request(
        "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
        {
          owner,
          repo,
          asset_id: asset.id,
          headers: {
            Accept: "application/octet-stream",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      const data = await fetch(assetUrl, {
        headers: {
          accept: "application/octet-stream",
          authorization: `token <${gitHubKey}>`,
        },
      })
        .then((x) => x.buffer())
        .catch((err) => {
          core.setFailed(`Fail to download file ${url}: ${err}`);
          return undefined;
        });
      if (data === undefined) return;

      await octo.rest.repos.uploadReleaseAsset({
        owner: destRepoOwner,
        repo: destRepoName,
        release_id: destRelease.id,
        name: asset.name,
        label: asset.label,
        data,
        headers: {
          "content-length": asset.size,
          "content-type": asset.content_type,
        },
      });
    });
    await Promise.all(assetPromises);

    const time = new Date().toTimeString();
    core.setOutput("time", time);
  } catch (error) {
    console.log(error);
    core.setFailed(error.message);
  }
}

run();
