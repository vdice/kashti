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
  constructor(name, img, tag, dir, registry, username, token, tenant) {
    super(name, "microsoft/azure-cli:latest");
    let acrImgPrefix = "public/deis/"
    let imgName = img + ":" + tag;
    this.tasks = [
      // service principal should have proper perms on the container registry.
      `az login --service-principal -u ${username} -p ${token} --tenant ${tenant}`,
      `cd ${dir}`,
      `echo '========> building ${img}...'`,
      `az acr build -r ${registry} -t ${acrImgPrefix}${imgName} .`,
      `echo '<======== finished building ${img}.'`
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
    var releaser = new ACRBuildJob(`${projectName}-release`, projectName, tag, "/src", project.secrets.acrName, project.secrets.acrUsername, project.secrets.acrToken, project.secrets.acrTenant);
    var latestReleaser = new ACRBuildJob(`${projectName}-release-latest`, projectName, "latest", "/src", project.secrets.acrName, project.secrets.acrUsername, project.secrets.acrToken, project.secrets.acrTenant);
    Group.runAll([start, releaser, latestReleaser])
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
