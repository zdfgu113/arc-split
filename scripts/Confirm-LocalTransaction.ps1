$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($null -eq $payload.intent -or $payload.summary.Length -gt 20000) { exit 1 }
Add-Type -AssemblyName PresentationFramework
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$signingScript = Join-Path $PSScriptRoot 'local-signing.mjs'
[xml]$layout = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="同账 · 本机交易确认" Width="650" Height="800" MinHeight="580" WindowStartupLocation="CenterScreen" Background="#F6F7F3" FontFamily="Microsoft YaHei UI">
 <Grid Margin="26">
  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <TextBlock Text="核对后，再签名" FontSize="24" FontWeight="SemiBold" Foreground="#163A32" Margin="0,0,0,16"/>
  <TextBox Grid.Row="1" Name="SummaryText" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" Padding="14" Background="White" BorderBrush="#D8DFD0" FontSize="13"/>
  <CheckBox Grid.Row="2" Name="Acknowledge" Content="我已核对网络、全部地址、金额与费用上限" Margin="0,18,0,12"/>
  <StackPanel Grid.Row="3"><TextBlock Text="只在此窗口输入本机钱包密码" Foreground="#163A32" Margin="0,0,0,6"/><PasswordBox Name="PasswordInput" MaxLength="1024" FontSize="16" Padding="10" Margin="0,0,0,14"/></StackPanel>
  <Button Grid.Row="4" Name="ConfirmButton" Content="签名并提交这笔交易" Padding="13" Background="#163A32" Foreground="White" BorderThickness="0" FontSize="15"/>
  <TextBlock Grid.Row="5" Name="StatusText" Text="关闭窗口即可取消。密码不进入网页，解密后的私钥只用于当前交易，进程结束后不再保留。" TextWrapping="Wrap" Foreground="#53654B" FontSize="12" Margin="0,13,0,0"/>
 </Grid>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $layout))
$window.FindName('SummaryText').Text = $payload.summary
$passwordInput = $window.FindName('PasswordInput')
$acknowledge = $window.FindName('Acknowledge')
$confirmButton = $window.FindName('ConfirmButton')
$statusText = $window.FindName('StatusText')
$script:result = $null
$script:attempted = $false
$script:active = $false
$window.Add_Closing({ param($sender, $eventArgs) if ($script:active) { $eventArgs.Cancel = $true } })
$confirmButton.Add_Click({
    if (-not $acknowledge.IsChecked) { $statusText.Text = '请先逐项核对并勾选确认。'; return }
    if ($passwordInput.Password.Length -lt 12) { $statusText.Text = '请输入创建钱包时设置的密码。'; return }
    $script:attempted = $true
    $script:active = $true
    $confirmButton.IsEnabled = $false
    $passwordInput.IsEnabled = $false
    $statusText.Text = '正在重新验证交易、解锁并提交，请保留窗口……'
    $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Render)
    try {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $nodePath
        $start.ArgumentList.Add($signingScript)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardInputEncoding = New-Object Text.UTF8Encoding $false
        $start.StandardOutputEncoding = New-Object Text.UTF8Encoding $false
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $start
        [void]$process.Start()
        $inputBody = @{ intent = $payload.intent; summary = $payload.summary; password = $passwordInput.Password } | ConvertTo-Json -Depth 6 -Compress
        $process.StandardInput.WriteLine($inputBody)
        $process.StandardInput.Close()
        $inputBody = $null
        $passwordInput.Clear()
        $publicOutput = $process.StandardOutput.ReadToEnd()
        $null = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $publicResult = $publicOutput | ConvertFrom-Json
        $process.Dispose()
        if ($publicResult.ok -and $publicResult.hash -match '^0x[0-9a-fA-F]{64}$') {
            $script:result = $publicResult
            $script:active = $false
            $window.Close()
        } else { $statusText.Text = '未能完成签名。请检查密码、余额或网络；可在有效期内重试。关闭后请核查付款状态。' }
    } catch { $statusText.Text = '未取得完整结果，请保留交易记录并核查，不要重复付款。' }
    finally { $passwordInput.Clear(); $script:active = $false; $confirmButton.IsEnabled = $true; $passwordInput.IsEnabled = $true }
})
[void]$window.ShowDialog()
if ($null -eq $script:result) {
    $code = if ($script:attempted) { 'native_result_unknown' } else { 4001 }
    $script:result = @{ ok = $false; code = $code }
}
[Console]::Out.WriteLine(($script:result | ConvertTo-Json -Compress))
