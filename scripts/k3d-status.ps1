param(
  [string]$ClusterName = "spendlens",
  [int]$RequestTimeoutSeconds = 12
)

$ErrorActionPreference = "Continue"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title =="
}

function Get-CommandPathOrNull {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

function Invoke-WithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds
  )

  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not (Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $outText = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
      $errText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
      if ($outText) { Write-Host $outText.TrimEnd() }
      if ($errText) { Write-Host $errText.TrimEnd() }
      Write-Host "Command timed out after $TimeoutSeconds seconds: $FilePath $($Arguments -join ' ')"
      return 124
    }

    $outText = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
    $errText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
    if ($outText) { Write-Host $outText.TrimEnd() }
    if ($errText) { Write-Host $errText.TrimEnd() }
    return $process.ExitCode
  } finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

$contextName = "k3d-$ClusterName"

Write-Section "Tools"
$k3dPath = Get-CommandPathOrNull "k3d"
$kubectlPath = Get-CommandPathOrNull "kubectl"
$dockerPath = Get-CommandPathOrNull "docker"

Write-Host "k3d:    $(if ($k3dPath) { $k3dPath } else { 'not found in PATH' })"
Write-Host "kubectl: $(if ($kubectlPath) { $kubectlPath } else { 'not found in PATH' })"
Write-Host "docker:  $(if ($dockerPath) { $dockerPath } else { 'not found in PATH' })"

if ($k3dPath) {
  Write-Section "k3d clusters"
  & k3d version
  & k3d cluster list
}

if ($dockerPath) {
  Write-Section "Docker containers"
  & docker ps -a --filter "name=k3d-$ClusterName" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"
}

if ($kubectlPath) {
  Write-Section "kubectl context"
  & kubectl config get-contexts

  Write-Section "Kubernetes resources"
  $exitCode = Invoke-WithTimeout -FilePath "kubectl" -Arguments @(
    "--context",
    $contextName,
    "--request-timeout=$($RequestTimeoutSeconds)s",
    "get",
    "nodes,pods,svc",
    "-A",
    "-o",
    "wide"
  ) -TimeoutSeconds ($RequestTimeoutSeconds + 8)
  if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "kubectl could not reach $contextName. The k3d Docker containers may exist while the Kubernetes API is not reachable from this host."
    exit $exitCode
  }
}
