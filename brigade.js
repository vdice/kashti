const { events, Job, Group } = require("brigadier");

const projectName = "kashti";

class TestJob extends Job {
  constructor(name) {
    super(name, "deis/node-chrome:node8");
    this.tasks = [
      "cd /src",
      "yarn global add @angular/cli",
      "yarn install",
      "ng lint",
      "ng test --browsers=ChromeHeadless",
    ];
  }
}

class E2eJob extends Job {
  constructor(name) {
    super(name, "deis/node-chrome:node8");
    this.tasks = [
      "apt-get update -yq && apt-get install -yq --no-install-recommends udev ttf-freefont chromedriver chromium",
      "cd /src",
      "yarn global add @angular/cli",
      "yarn install",
      "ng e2e"
    ];
  }
}

class ACRBuildJob extends Job {
  constructor(name, img, tag, project) {
    super(name, "microsoft/azure-cli:latest");
    let imgName = "public/deis/" + img + ":" + tag;

    this.tasks = [
      // service principal should have proper perms on the container registry.
      `az login --service-principal -u ${project.secrets.acrUsername} -p ${project.secrets.acrToken} --tenant ${project.secrets.acrTenant}`,
      `cd /src`,
      `echo '========> building ${imgName}...'`,
      `az acr build -r ${project.secrets.acrName} -t ${imgName} .`,
      `echo '<======== finished building ${imgName}.'`
    ];
  }
}

class DockerhubPublishJob extends Job {
  constructor(name, img, tag, project) {
    super(name, "docker");
    let dockerRegistry = project.secrets.dockerhubRegistry || "docker.io";
    let dockerOrg = project.secrets.dockerhubOrg || "deis";
    let imgName = dockerOrg + img + ":" + tag;

    this.docker.enabled = "true";
    this.tasks = [
      `docker login ${dockerRegistry} -u ${project.secrets.dockerhubUsername} -p ${project.secrets.dockerhubPassword}`,
      `cd /src`,
      `echo '========> building ${imgName}...'`,
      `docker build -t ${imgName} .`,
      `echo '<======== finished building ${imgName}.'`,
      `echo '========> publishing ${imgName}...'`,
      `docker push ${imgName}`,
      `echo '<======== finished publishing ${imgName}.'`,
    ];
  }
}

function ghNotify(state, msg, e, project) {
  const gh = new Job(`notify-${state}`, "technosophos/github-notify:latest");
  gh.env = {
    GH_REPO: project.repo.name,
    GH_STATE: state,
    GH_DESCRIPTION: msg,
    GH_CONTEXT: "brigade",
    GH_TOKEN: project.secrets.ghToken,
    GH_COMMIT: e.revision.commit
  }
  return gh
}

function test() {
  const test = new TestJob(`${projectName}-test`)
  const e2e = new E2eJob(`${projectName}-e2e`)
  return Group.runAll([test, e2e]);
}

function githubRelease(e, project) {
  const gh = JSON.parse(e.payload);
  if (gh.ref.startsWith("refs/tags/") || gh.ref == "refs/heads/master") {
    const start = ghNotify("pending", `release started as ${e.buildID}`, e, project)

    let parts = gh.ref.split("/", 3);
    let tag = parts[2];

    const acrReleasers = [
      new ACRBuildJob(`${projectName}-acr-release`, projectName, tag, project.secrets.acrName, project.secrets.acrUsername, project.secrets.acrToken, project.secrets.acrTenant),
      new ACRBuildJob(`${projectName}-acr-release-latest`, projectName, "latest", project.secrets.acrName, project.secrets.acrUsername, project.secrets.acrToken, project.secrets.acrTenant)
    ];
    const dockerhubReleasers = [
      new DockerhubPublishJob(`${projectName}-dockerhub-release`, projectName, tag),
      new DockerhubPublishJob(`${projectName}-dockerhub-release-latest`, projectName, "latest")
    ]

    Group.runAll([start].concat(acrReleasers).concat(dockerhubReleasers))
      .then(() => {
        return ghNotify("success", `release ${e.buildID} finished successfully`, e, project).run()
      })
      .catch(err => {
        return ghNotify("failure", `failed release ${e.buildID}`, e, project).run()
      });
  } else {
    console.log('not a tag or a push to master; skipping')
  }
}

function githubTest(e, project) {
  const start = ghNotify("pending", `build started as ${e.buildID}`, e, project)
  const test = new TestJob(`${projectName}-test`)
  const e2e = new E2eJob(`${projectName}-e2e`)
  Group.runAll([start, test, e2e])
    .then(() => {
      return ghNotify("success", `build ${e.buildID} passed`, e, project).run()
    })
    .catch(err => {
      return ghNotify("failure", `failed build ${e.buildID}`, e, project).run()
    });
}

events.on("exec", test);
events.on("push", githubRelease);
events.on("pull_request", githubTest);

events.on("release_images", (e, project) => {
  console.log(e)
  console.log(project)
  const acrReleasers = [
    new ACRBuildJob(`${projectName}-acr-release-latest`, projectName, "latest", project)
  ];
  const dockerhubReleasers = [
    new DockerhubPublishJob(`${projectName}-dockerhub-release-latest`, projectName, "latest", project)
  ];

  console.log(acrReleasers.concat(dockerhubReleasers));

  Group.runAll(acrReleasers.concat(dockerhubReleasers));

  console.log("kicked 'em off");
});
