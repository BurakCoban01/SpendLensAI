import { execFileSync, spawnSync } from "node:child_process";

const images = [
  { name: "api", tag: "spendlens/api:local", dockerfile: "apps/api/Dockerfile" },
  { name: "web", tag: "spendlens/web:local", dockerfile: "apps/web/Dockerfile" },
  { name: "ocr-service", tag: "spendlens/ocr-service:local", dockerfile: "services/ocr/Dockerfile" }
];

const options = parseArgs(process.argv.slice(2));
const plan = buildPlan(options);

if (options.dryRun) {
  console.log("Kubernetes local image plan:");
  for (const command of plan) {
    console.log(`- ${formatCommand(command)}`);
  }
  process.exit(0);
}

for (const command of plan) {
  console.log(formatCommand(command));
  execFileSync(command.bin, command.args, { stdio: "inherit" });
}

console.log("Kubernetes local images are ready.");

function buildPlan(options) {
  const commands = [];

  if (!options.loadOnly) {
    for (const image of images) {
      commands.push({
        bin: "docker",
        args: ["build", "-f", image.dockerfile, "-t", image.tag, "."]
      });
    }
  }

  if (options.buildOnly || options.cluster === "none") return commands;

  const cluster = options.cluster === "auto" ? (options.dryRun ? "kind" : detectCluster(options.clusterName)) : options.cluster;
  if (cluster === "none") return commands;

  for (const image of images) {
    commands.push(loadCommand(cluster, image.tag, options.clusterName));
  }

  return commands;
}

function loadCommand(cluster, tag, clusterName) {
  if (cluster === "kind") {
    return { bin: "kind", args: ["load", "docker-image", tag, "--name", clusterName] };
  }
  if (cluster === "k3d") {
    return { bin: "k3d", args: ["image", "import", tag, "--cluster", clusterName] };
  }
  if (cluster === "minikube") {
    return { bin: "minikube", args: ["image", "load", tag] };
  }
  throw new Error(`Unsupported cluster type: ${cluster}`);
}

function detectCluster(clusterName) {
  if (commandSucceeds("kind", ["get", "clusters"], clusterName)) return "kind";
  if (commandSucceeds("k3d", ["cluster", "list", "--no-headers"], clusterName)) return "k3d";
  if (spawnSync("minikube", ["status", "--format", "{{.Host}}"], { encoding: "utf8" }).stdout.trim() === "Running") {
    return "minikube";
  }
  throw new Error(
    "No running local Kubernetes image target detected. Use --cluster kind|k3d|minikube|none, or run with --dry-run."
  );
}

function commandSucceeds(bin, args, expectedText) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  return result.status === 0 && result.stdout.split(/\r?\n/).map((line) => line.trim()).includes(expectedText);
}

function parseArgs(args) {
  const options = {
    cluster: "auto",
    clusterName: "spendlens",
    dryRun: false,
    buildOnly: false,
    loadOnly: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--build-only") {
      options.buildOnly = true;
    } else if (arg === "--load-only") {
      options.loadOnly = true;
    } else if (arg === "--cluster") {
      options.cluster = readValue(args, ++index, "--cluster");
    } else if (arg.startsWith("--cluster=")) {
      options.cluster = arg.slice("--cluster=".length);
    } else if (arg === "--cluster-name") {
      options.clusterName = readValue(args, ++index, "--cluster-name");
    } else if (arg.startsWith("--cluster-name=")) {
      options.clusterName = arg.slice("--cluster-name=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["auto", "kind", "k3d", "minikube", "none"].includes(options.cluster)) {
    throw new Error("--cluster must be one of auto, kind, k3d, minikube or none.");
  }
  if (options.buildOnly && options.loadOnly) {
    throw new Error("--build-only and --load-only cannot be used together.");
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(options.clusterName)) {
    throw new Error("--cluster-name contains unsupported characters.");
  }

  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function formatCommand(command) {
  return [command.bin, ...command.args.map(quoteArg)].join(" ");
}

function quoteArg(value) {
  return /[\s"]/u.test(value) ? JSON.stringify(value) : value;
}
