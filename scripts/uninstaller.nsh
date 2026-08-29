; ============================================================
; EzTxt custom NSIS uninstaller script (electron-builder include)
; Mounted via package.json build.nsis.include.
; Defines two macros auto-invoked by electron-builder's uninstaller.nsh:
;   - customUnInit    : run at uninstall init (kill running app to avoid file locks)
;   - customUnInstall : run after uninstall body (clean userData caches, keep todos)
; ============================================================

!macro customUnInit
  ; Kill running main process (including tray-resident) so the exe/data files
  ; are not locked. Try graceful close first (lets the app save), then force.
  nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  Sleep 300
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  Sleep 300
!macroend

!macro customUnInstall
  ; Clean non-persistent files under %APPDATA% app userData,
  ; KEEP the storage folder (note.json todos, settings.json).
  ; Electron userData dir may be named name (eztxt), productName (EzTxt)
  ; or productFilename; try each.
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Cache"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Code Cache"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\GPUCache"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\DawnCache"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Crashes"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\logs"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\blob_storage"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Session Storage"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Local Storage"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\IndexedDB"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\OriginTrials"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\Network"
    Delete "$APPDATA\${APP_PACKAGE_NAME}\Preferences"
    Delete "$APPDATA\${APP_PACKAGE_NAME}\Cookies"
    Delete "$APPDATA\${APP_PACKAGE_NAME}\storage-location.json"
  !endif
  !ifdef APP_FILENAME
    RMDir /r "$APPDATA\${APP_FILENAME}\Cache"
    RMDir /r "$APPDATA\${APP_FILENAME}\Code Cache"
    RMDir /r "$APPDATA\${APP_FILENAME}\GPUCache"
    RMDir /r "$APPDATA\${APP_FILENAME}\DawnCache"
    RMDir /r "$APPDATA\${APP_FILENAME}\Crashes"
    RMDir /r "$APPDATA\${APP_FILENAME}\logs"
    RMDir /r "$APPDATA\${APP_FILENAME}\blob_storage"
    RMDir /r "$APPDATA\${APP_FILENAME}\Session Storage"
    RMDir /r "$APPDATA\${APP_FILENAME}\Local Storage"
    RMDir /r "$APPDATA\${APP_FILENAME}\IndexedDB"
    RMDir /r "$APPDATA\${APP_FILENAME}\OriginTrials"
    RMDir /r "$APPDATA\${APP_FILENAME}\Network"
    Delete "$APPDATA\${APP_FILENAME}\Preferences"
    Delete "$APPDATA\${APP_FILENAME}\Cookies"
    Delete "$APPDATA\${APP_FILENAME}\storage-location.json"
  !endif
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Cache"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Code Cache"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\GPUCache"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\DawnCache"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Crashes"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\logs"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\blob_storage"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Session Storage"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Local Storage"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\IndexedDB"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\OriginTrials"
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\Network"
    Delete "$APPDATA\${APP_PRODUCT_FILENAME}\Preferences"
    Delete "$APPDATA\${APP_PRODUCT_FILENAME}\Cookies"
    Delete "$APPDATA\${APP_PRODUCT_FILENAME}\storage-location.json"
  !endif
!macroend
