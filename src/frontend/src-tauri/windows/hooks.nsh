; Tauri 默认仅清理以 bundle identifier 命名的 AppData 目录。
; AssetOps 的默认配置和数据放在安装目录旁，遵循相同的删除勾选和升级条件。
; 显示名与安装目录分开；旧中文默认目录升级至 AssetOps，自选目录仍保留。
Var RunningAppProcess

; Restart Manager 返回成功后仍要等待原进程退出，不能只以窗口关闭为准。
!macro CheckAndStopRunningApp executablePath productName
  StrCpy $RunningAppProcess 0
  FindWindow $0 "${BUNDLEID}-sic" "${BUNDLEID}-siw"
  ${If} $0 P<> 0
    System::Call 'user32::GetWindowThreadProcessId(p r0, *i .r1)'
    System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i r1) p .r2'
    ${If} $2 P<> 0
      StrCpy $3 ${NSIS_MAX_STRLEN}
      System::Call 'kernel32::QueryFullProcessImageNameW(p r2, i 0, w .r4, *i r3) i .r0'
      ${If} $0 <> 0
      ${AndIf} $4 == "${executablePath}"
        StrCpy $RunningAppProcess $2
      ${Else}
        System::Call 'kernel32::CloseHandle(p r2)'
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !insertmacro CheckIfAppIsRunning "${executablePath}" "${productName}"
  ${If} $RunningAppProcess P<> 0
    System::Call 'kernel32::WaitForSingleObject(p $RunningAppProcess, i 5000) i .r0'
    ${If} $0 = 258
      System::Call 'kernel32::TerminateProcess(p $RunningAppProcess, i 0)'
      System::Call 'kernel32::WaitForSingleObject(p $RunningAppProcess, i 5000) i .r0'
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p $RunningAppProcess)'
    StrCpy $RunningAppProcess 0
    ${If} $0 <> 0
      MessageBox MB_ICONSTOP "旧版 ${productName} 未能完全退出，请从托盘退出后重试安装。" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend

Var LegacyDefaultInstallDirectory
Function AdoptLegacyInstallLocation
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\assetops\工作台" ""
  ${If} $0 == ""
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\工作台"
    ReadRegStr $1 HKCU "Software\assetops\运维工作台" ""
    ${If} $1 == ""
    ${OrIfNot} ${FileExists} "$1\assetops.exe"
    ${OrIfNot} ${FileExists} "$1\config.json"
      ReadRegStr $1 HKCU "Software\assetops\AssetOps" ""
    ${EndIf}
    ${If} $1 != ""
    ${AndIf} ${FileExists} "$1\assetops.exe"
    ${AndIf} ${FileExists} "$1\config.json"
      StrCpy $INSTDIR $1
    ${EndIf}
  ${EndIf}
  ${If} $INSTDIR == "$LOCALAPPDATA\工作台"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA\运维工作台"
    ${If} ${FileExists} "$INSTDIR\config.json"
      StrCpy $LegacyDefaultInstallDirectory $INSTDIR
    ${EndIf}
    StrCpy $INSTDIR "$LOCALAPPDATA\AssetOps"
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

!define MUI_CUSTOMFUNCTION_GUIINIT AdoptLegacyInstallLocation

!macro NSIS_HOOK_PREINSTALL
  Call AdoptLegacyInstallLocation
  !insertmacro CheckAndStopRunningApp "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  SetOutPath $INSTDIR
  ${If} $LegacyDefaultInstallDirectory != ""
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\AssetOps"
    !insertmacro CheckAndStopRunningApp "$LegacyDefaultInstallDirectory\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    ${If} ${FileExists} "$INSTDIR\config.json"
    ${OrIf} ${FileExists} "$INSTDIR\data"
      MessageBox MB_ICONSTOP "AssetOps 目录已存在数据。旧目录和目标目录的数据均已保留，请先核对后再安装。" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
    ClearErrors
    ${If} ${FileExists} "$LegacyDefaultInstallDirectory\data"
      CreateDirectory "$INSTDIR\data"
      CopyFiles /SILENT "$LegacyDefaultInstallDirectory\data\*.*" "$INSTDIR\data"
    ${EndIf}
    ${IfNot} ${Errors}
      CopyFiles /SILENT "$LegacyDefaultInstallDirectory\config.json" "$INSTDIR\config.json"
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "旧目录数据复制失败，原数据已保留。请检查磁盘空间和目录权限后重试。" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckAndStopRunningApp "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"
  ${If} $0 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\"'
  ${EndIf}
  ReadRegStr $0 HKCU "Software\assetops\运维工作台" ""
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "Software\assetops\运维工作台"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\运维工作台"
    !insertmacro IsShortcutTarget "$DESKTOP\运维工作台.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\运维工作台.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\运维工作台.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\运维工作台.lnk"
    ${EndIf}
  ${EndIf}
  ReadRegStr $0 HKCU "Software\assetops\AssetOps" ""
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "Software\assetops\AssetOps"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AssetOps"
    !insertmacro IsShortcutTarget "$DESKTOP\AssetOps.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\AssetOps.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\AssetOps.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\AssetOps.lnk"
    ${EndIf}
  ${EndIf}
  ; exe、快捷方式、安装器和卸载器使用同一 ICO；升级后通知 Windows 刷新旧的图标缓存。
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$INSTDIR\uninstall.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $INSTDIR != ""
    Delete "$INSTDIR\config.json"
    Delete "$INSTDIR\config.json.tmp"
    RMDir /r "$INSTDIR\data"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
