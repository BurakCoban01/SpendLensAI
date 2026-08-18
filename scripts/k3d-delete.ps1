param(
  [string]$ClusterName = "spendlens",
  [switch]$ConfirmDelete
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmDelete -and $env:SPENDLENS_CONFIRM_K3D_DELETE -ne "1") {
  throw "Refusing to delete k3d cluster '$ClusterName' without confirmation. Run: pnpm k3d:delete -- -ConfirmDelete"
}

if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
  throw "k3d is not available in PATH. Install k3d first or run a local k3d.exe explicitly."
}

& k3d cluster delete $ClusterName
Write-Host "Deleted k3d cluster '$ClusterName'."
