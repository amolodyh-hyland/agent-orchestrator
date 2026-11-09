param(
    [Parameter(Mandatory=$true)][ValidateSet('inspect','list','close','private','listener')][string]$Operation,
    [string]$Target,
    [int]$ProcessId,
    [string]$Started,
    [int]$Port
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows is required' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Identity($item) {
    $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.Id)"
    if (!$native) { throw 'Process identity unavailable' }
    $owner = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw 'Process belongs to another user' }
    if (!$item.Path) { throw 'Process executable unavailable' }
    [pscustomobject]@{ pid=$item.Id; executable=$item.Path; processStart=('windows-filetime:'+$item.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)); ownerSid=$owner.Sid; mainWindow=($item.MainWindowHandle -ne [IntPtr]::Zero) }
}
switch ($Operation) {
    'listener' {
        if ($Port -lt 1 -or $Port -gt 65535 -or $ProcessId -le 1) { throw 'Invalid listener identity' }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
        if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $ProcessId) { throw 'Loopback listener owner differs from daemon PID' }
        [pscustomobject]@{pid=$ProcessId; port=$Port} | ConvertTo-Json -Compress
    }
    'inspect' {
        $item = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (!$item) { 'null'; exit 0 }
        Identity $item | ConvertTo-Json -Compress
    }
    'list' {
        $items = @(Get-Process | Where-Object { $_.Path -and [string]::Equals($_.Path, $Target, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Identity $_ })
        ConvertTo-Json -InputObject $items -Compress
    }
    'close' {
        $item = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (!$item) { throw 'Process disappeared before close' }
        $identity = Identity $item
        if ($identity.processStart -ne $Started -or ![string]::Equals($identity.executable, $Target, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Process identity changed before close' }
        if (!$item.CloseMainWindow()) { throw 'App has no closeable main window; quit it manually' }
        'null'
    }
    'private' {
        $item = Get-Item -LiteralPath $Target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private directory is a reparse point' }
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($sid)))
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($principal in @($sid, 'S-1-5-18')) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($principal)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Target -AclObject $acl
        $actual = Get-Acl -LiteralPath $Target
        [pscustomobject]@{ ownerSid=$actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$actual.AreAccessRulesProtected; allowedSids=@($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress
    }
}
