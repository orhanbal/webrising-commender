# Uygulama arşivi — 2026-11-10 (native yeniden yazım öncesi)

Sahip kararı (B + F): Windows ve macOS için **gerçek native** uygulamalar, Yönetim
Merkezi ile masaüstü uygulaması **tek uygulamada**. Mevcut uygulamalar korunur;
istenirse bu belgedeki commit'lere geri dönülür.

## Korunan uygulamalar

| Uygulama | Klasör | Teknoloji |
|---|---|---|
| Windows Yönetim Merkezi (native) | `center-windows/` | WinUI 3, C# |
| Windows/Linux Yönetim Merkezi (tepsi) | `tray/` | Tauri 2 |
| macOS Yönetim Merkezi | `center-macos/` | SwiftUI |
| Masaüstü uygulaması (SSH, SFTP, tüneller, atlama sunucusu, tepsi, Agent Mode) | `desktop/` | Tauri 2 |

Bu klasörler silinmez; yeni native uygulamalar onların yerine geçene ve sahip onay
verene kadar CI'da derlenmeye devam eder.

## Geri dönüş noktaları

- main, arşiv anında: `c799d7ecc60ebb4316d65cf88eba7742f73dfe0d` (canlıda: dc5fb2e…, #129 dahil main)
- masaüstü uygulamasının tam hali (#130 dalı): `b5b85d89aa10192b3686f1a0330218baa6f2424d`
- Yayınlanmış paketler GitHub Releases'ta kalır: `ubuntu-preview-*`, `macos-preview-*`,
  `center-linux-latest`, `macos-center-latest`.

Geri dönmek için (bir klasörü arşivdeki haline getirmek):

```bash
git checkout c799d7ecc60ebb4316d65cf88eba7742f73dfe0d -- center-windows center-macos tray desktop
```

Not: Bu oturumdan git etiketi gönderilemediği için geri dönüş noktaları commit
kimlikleriyle tutulur; main geçmişi değişmez olduğundan kalıcıdır. İstenirse sahip
`git tag archive/2026-11-10 c799d7ecc60ebb4316d65cf88eba7742f73dfe0d && git push origin archive/2026-11-10` ile etiketleyebilir.
