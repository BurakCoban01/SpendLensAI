param(
  [string]$ClusterName = "spendlens",
  [int]$ApiPort = 53428
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
  throw "k3d is not available in PATH. Install k3d first or run a local k3d.exe explicitly."
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  throw "kubectl is not available in PATH."
}

$clusterNames = (& k3d cluster list --no-headers 2>$null) -replace "\s+.*$", ""
if ($clusterNames -contains $ClusterName) {
  & k3d cluster start $ClusterName
} else {
  & k3d cluster create $ClusterName --api-port "127.0.0.1:$ApiPort" --agents 0
}

& kubectl config use-context "k3d-$ClusterName"
Write-Host "k3d cluster '$ClusterName' is selected. Load local images with 'pnpm k8s:images -- --cluster k3d --cluster-name $ClusterName' before applying manifests."
