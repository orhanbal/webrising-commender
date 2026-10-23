; WECOMMANDER Windows Setup — packaged on a Windows GitHub runner with Inno Setup
#define AppName "WECOMMANDER"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
[Setup]
AppId={{A4B3727B-DC86-4350-9287-27A6DAE1109D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=WECOMMANDER
DefaultDirName={autopf}\WECOMMANDER
DefaultGroupName=WECOMMANDER
UninstallDisplayName=WECOMMANDER Agent
OutputDir=output
OutputBaseFilename=WECOMMANDER-Setup-windows-x64
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
DisableProgramGroupPage=yes
[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Files]
Source: "webrising-commender.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "WECOMMANDER-Onboarding.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "Install-Service-Interactive.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
[Icons]
Name: "{group}\WECOMMANDER Cihaz Bağlantısı"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\WECOMMANDER-Onboarding.ps1"""; WorkingDir: "{app}"
Name: "{group}\WECOMMANDER Panel"; Filename: "https://wecommander.webrising.tr/dashboard"
[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\WECOMMANDER-Onboarding.ps1"""; Description: "Cihazımı bağla / Connect my device"; Flags: postinstall skipifsilent nowait
[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-windows.ps1"""; Flags: runhidden; RunOnceId: "stop-agent-service"
