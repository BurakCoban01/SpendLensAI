param(
  [string]$ClusterName = "spendlens"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
  throw "k3d is not available in PATH. Install k3d first or run a local k3d.exe explicitly."
}

& k3d cluster stop $ClusterName
Write-Host "Stopped k3d cluster '$ClusterName'. No containers, volumes or kubeconfig entries were deleted."
