param([switch]$VerifyOnly, [switch]$TestRecipient)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework

$walletDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\secrets\arc-split'
$keystorePath = Join-Path $walletDirectory $(if ($TestRecipient) { 'recipient-wallet-v3.json' } else { 'wallet-v3.json' })
$publicPath = Join-Path $walletDirectory $(if ($TestRecipient) { 'recipient-wallet-public.json' } else { 'wallet-public.json' })
$statePath = Join-Path $walletDirectory $(if ($TestRecipient) { 'recipient-creation-state.public.json' } else { 'creation-state.public.json' })
$walletScript = Join-Path $PSScriptRoot 'local-wallet.mjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

$newDirectory = -not (Test-Path -LiteralPath $walletDirectory)
if ($newDirectory) { New-Item -ItemType Directory -Path $walletDirectory | Out-Null }
if ((Get-Item -LiteralPath $walletDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Wallet directory must be a normal local directory.' }
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$allowedSids = @($ownerSid.Value, $systemSid.Value)
if ($newDirectory) {
    & icacls.exe $walletDirectory /inheritance:r /grant:r "*$($ownerSid.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict wallet directory permissions.' }
}
$acl = Get-Acl -LiteralPath $walletDirectory
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules | Where-Object { $_.IdentityReference.Value -notin $allowedSids -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count) { throw 'Wallet directory permissions need verification; no wallet was changed.' }

$existing = Test-Path -LiteralPath $keystorePath
if ($VerifyOnly -and -not $existing) { throw 'No wallet exists to verify.' }
$operation = if ($existing) { 'verify' } else { 'create' }
@{ status = 'waiting_for_local_password'; operation = $operation; keystorePath = $keystorePath } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

[xml]$layout = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="同账 · 本机加密钱包" Width="560" Height="540" ResizeMode="CanMinimize" WindowStartupLocation="CenterScreen" Background="#F6F7F3" FontFamily="Microsoft YaHei UI">
 <StackPanel Margin="30">
  <TextBlock Text="创建你的本机钱包" Name="TitleText" FontSize="23" FontWeight="SemiBold" Foreground="#163A32" Margin="0,0,0,12"/>
  <TextBlock Text="私钥只在本机生成并加密保存，不会发送到聊天或网站。这个窗口只创建 / 验证钱包，不签名、不转账。" TextWrapping="Wrap" FontSize="13" Foreground="#53654B" Margin="0,0,0,18"/>
  <TextBlock Text="加密密码（至少 12 个字符）" FontSize="13" Foreground="#163A32" Margin="0,0,0,6"/>
  <PasswordBox Name="PasswordInput" FontSize="16" Padding="10" MaxLength="1024" Margin="0,0,0,13"/>
  <TextBlock Name="RepeatLabel" Text="再次输入密码" FontSize="13" Foreground="#163A32" Margin="0,0,0,6"/>
  <PasswordBox Name="RepeatInput" FontSize="16" Padding="10" MaxLength="1024" Margin="0,0,0,13"/>
  <TextBlock Text="保存位置" FontSize="12" Foreground="#65755B"/>
  <TextBox Name="PathText" IsReadOnly="True" BorderThickness="0" Background="Transparent" FontSize="11" TextWrapping="Wrap" Margin="0,4,0,14"/>
  <Button Name="CreateButton" Content="创建并加密保存" Padding="14" Background="#163A32" Foreground="White" FontSize="14" BorderThickness="0"/>
  <TextBlock Name="StatusText" Text="密码丢失将无法恢复钱包。创建后请另存加密文件备份，并分开保管密码。" TextWrapping="Wrap" Foreground="#53654B" FontSize="12" Margin="0,15,0,0"/>
 </StackPanel>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $layout))
$passwordInput = $window.FindName('PasswordInput')
$repeatInput = $window.FindName('RepeatInput')
$createButton = $window.FindName('CreateButton')
$statusText = $window.FindName('StatusText')
$window.FindName('PathText').Text = $keystorePath
if ($TestRecipient) {
    $window.Title = '同账 · 测试收款钱包'
    $window.FindName('TitleText').Text = '创建本机测试收款钱包'
}
if ($existing) {
    $window.FindName('TitleText').Text = '验证已有本机钱包'
    $window.FindName('RepeatLabel').Visibility = 'Collapsed'
    $repeatInput.Visibility = 'Collapsed'
    $createButton.Content = '解锁校验地址，不转账'
    $statusText.Text = '检测到已有钱包，将只验证解锁和地址，绝不会覆盖原文件。'
}
$script:completed = $false
$createButton.Add_Click({
    if ($script:completed) { $window.Close(); return }
    if ($passwordInput.Password.Length -lt 12) { $statusText.Text = '密码至少需要 12 个字符。'; return }
    if (-not $existing -and $passwordInput.Password -cne $repeatInput.Password) { $statusText.Text = '两次密码不一致，请重新输入。'; return }
    $createButton.IsEnabled = $false
    $passwordInput.IsEnabled = $false
    $repeatInput.IsEnabled = $false
    $statusText.Text = '正在加密并重新解锁校验，请稍候……'
    $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Render)
    try {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $nodePath
        $start.ArgumentList.Add($walletScript)
        $start.ArgumentList.Add($operation)
        $start.ArgumentList.Add($keystorePath)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardInputEncoding = New-Object Text.UTF8Encoding $false
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $start
        [void]$process.Start()
        $inputBody = @{ password = $passwordInput.Password } | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($inputBody)
        $process.StandardInput.Close()
        $inputBody = $null
        $passwordInput.Clear()
        $repeatInput.Clear()
        $publicOutput = $process.StandardOutput.ReadToEnd()
        [void]$process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $result = $publicOutput | ConvertFrom-Json
        if (-not $result.ok) { throw $result.message }
        $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $publicPath -Encoding utf8
        @{ status = 'completed'; operation = $operation; address = $result.address; verified = $result.verified } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $script:completed = $true
        $statusText.Text = "已完成加密及解锁校验。`n钱包地址：$($result.address)`n请备份加密文件，密码另存。此窗口未执行签名或转账。"
        $createButton.Content = '完成，关闭窗口'
    } catch {
        $statusText.Text = '操作未完成。请检查密码；如已生成钱包文件，请保留原文件，不要删除或覆盖。'
        @{ status = 'needs_attention'; operation = $operation; keystoreExists = (Test-Path -LiteralPath $keystorePath) } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $passwordInput.IsEnabled = $true
        $repeatInput.IsEnabled = $true
    } finally { $createButton.IsEnabled = $true }
})
$window.Add_Closed({
    if (-not $script:completed) { @{ status = 'closed_without_completion'; operation = $operation; keystoreExists = (Test-Path -LiteralPath $keystorePath) } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8 }
})
$window.Add_ContentRendered({ $window.Activate(); $passwordInput.Focus() })
[void]$window.ShowDialog()
