import { execFile } from "node:child_process";

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  const safeTitle = escapePowerShellString(title);
  const safeBody = escapePowerShellString(body);

  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${safeTitle}').Show(${toast})`,
  ].join("; ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=usage-alerts:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=usage-alerts:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

export function notifyOS(title: string, body: string): void {
  try {
    if (process.env.WT_SESSION) {
      notifyWindows(title, body);
    } else if (process.env.KITTY_WINDOW_ID) {
      notifyOSC99(title, body);
    } else {
      notifyOSC777(title, body);
    }
  } catch {
    // OS notification support is best-effort; the in-Pi notify is authoritative.
  }
}
