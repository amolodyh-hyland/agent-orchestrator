$ErrorActionPreference = 'Stop'
$frontend = Split-Path $PSScriptRoot -Parent
$output = Join-Path $frontend '.vite/dictation-windows-tests'
New-Item -ItemType Directory -Force $output | Out-Null
$sources = @('CaptureBuffer.cs', 'WaveInApi.cs', 'WaveInCapture.cs', 'Dictation.Stop.cs', 'StopTests.cs', 'CaptureBufferTests.cs') |
    ForEach-Object { Join-Path $frontend "native/dictation/$_" }

if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') {
    $executable = Join-Path $output 'capture-tests.exe'
    & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo "/out:$executable" $sources
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $executable
    exit $LASTEXITCODE
}

# PowerShell's bundled C# compiler/runtime runs the same production lifecycle
# with the fake WinMM API on macOS/Linux. No SDK, packages, or audio are needed.
$assemblyPath = Join-Path $output 'capture-tests.dll'
if (Test-Path $assemblyPath) { Remove-Item $assemblyPath }
Add-Type -Path $sources -OutputAssembly $assemblyPath -CompilerOptions '/langversion:5'
$assembly = [System.Reflection.Assembly]::LoadFrom($assemblyPath)
$main = $assembly.GetType('CaptureBufferTests').GetMethod('Main', [System.Reflection.BindingFlags]'Static,NonPublic')
$main.Invoke($null, $null)
