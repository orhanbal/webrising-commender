# WECOMMANDER — Desktop Commander İşlevsel Eşdeğerlik Planı

Son gözden geçirme: 2026-10-24. Öncelik: eşdeğerlik > güvenilirlik/kabul > farklılaşma. Yeni SaaS/ticari özelliklere girilmeden önce aşağıdaki kapsamdaki eksikler kapatılacak.

## Karşılaştırma kaynağı
- Desktop Commander'ın yayımlanan MCP araç listesi: https://github.com/mcp/wonderwhy-er/desktop-commander
- Remote MCP araç listesi: https://github.com/mcp/app.desktopcommander/remote-desktop-commander
- Resmî site: https://desktopcommander.app/
- WECOMMANDER kanonik kaynak: `gateway/src/mcp.ts`, `gateway/src/protocol.ts`, `crates/agent/src/*` ve `gateway/test/agent-e2e.mjs`.
- Amaç üçüncü tarafın kaynak kodunu kopyalamak değil, belgelenmiş davranışlarda bağımsız eşdeğerlik sağlamaktır.

## Tamamlandı / kodda mevcut — yine de gerçek istemci kabulü gerekebilir
- [x] Cihaz eşleştirme; Windows gerçek cihazda online ve `whoami` denendi.
- [x] Windows/Ubuntu/macOS build + doğrudan kurulum paketleri; CI başarı 17/17 (commit `755779eb`). **Gerçek macOS/Ubuntu kurulum kabulü yapılmadı.**
- [x] Dosya listeleme, meta veri, metin/ikili okuma-yazma, taşıma, silme; allowlisted roots.
- [x] Metin arama, dosya adı arama, recursive tree ve korumalı tekil replacement.
- [x] Kısa komutlar, PTY oturumları, görev/süreç yönetimi, yeniden bağlanma.
- [x] MCP `initialize`, `tools/list`, `tools/call`; **ChatGPT/Claude canlı connector kabulü henüz yok.**

## P0 — Desktop Commander temel MCP operasyon eşdeğerliği
- [ ] Büyük dosya/terminal çıktısında sayfalama: pozitif ve sondan negatif satır offset, kapasite sınırları, tail. Gerçek Agent+Gateway uçtan uca test.
- [ ] Çoklu dosya okuma: aynı cihaza 1-10 yollu, kısmi hata desteği, kaynak/kota kontrolü, E2E test.
- [ ] Akışlı arama oturumları: başlat/duraklat/sonuçları sayfalı getir/durdur, eşzamanlı arama; `ripgrep` uygun ise kullan.
- [ ] Process oturumlarında çıktı sayfalama, prompt/REPL belirleme, SIGTERM/tree-cleanup; Windows/macOS/Linux E2E.
- [ ] MCP standardı bağlantı/çağrı kontratına göre gerçek ChatGPT ve Claude kullanım kabulü; schema uyuşmazlıklarını gider.
- [ ] Cihaz eşleştirme, yeniden bağlanma, reboot, paket yükseltme, uninstall ve cihaz iptali: üç OS üzerinde fiziksel kabul.
- [ ] Güvenli dosya işleminde atomik düzenleme, çakışma beklentisi/rollback ve büyük dizin E2E.
- [ ] Konfigürasyon okuma/güncelleme: sınırlı dizinler, güvenli shell seçimi, engelli komutlar, yetkilendirme ve audit.
- [ ] Araç geçmişi ve işlemlerin çıktı özetlerine güvenli sayfalı erişim.

## P1 — Belge ve özel format eşdeğerliği
- [ ] Excel `.xlsx/.xlsm`: çalışma kitabı/sekme/alan okuma, hücre aralığı düzenleme, biçimi koruma, arama.
- [ ] DOCX: paragraf/tablo okuma, yapılandırılmış değişiklik, orijinal biçimi koruyan atomik kaydetme.
- [ ] PDF: sayfa/metin okuma, sayfa bazlı ekle/çıkar/birleştir ve özgün dosyaya zarar vermeyen güvenli çıktı.
- [ ] Görsel önizleme; güvenli format/metaveri görüntüleme.
- [ ] CSV/JSON/Markdown ve kod dosyaları için güçlü araçlar; çift yönlü içerik akışı.
- [ ] Performans regresyonları: büyük belge, eşzamanlı görev, bellek/CPU ve içerik kaybı testleri.

## P2 — Kullanıcı deneyimi ve dağıtım paritesi
- [ ] Tüm işlem türleri için çalışan okunabilir web ekranları, terminal, dosya ve arama sonuçları.
- [ ] Masaüstü/terminal paketlerinde kararlı yükleme, güncelleme ve kaldırma.
- [ ] macOS Developer ID + noter onayı (harici imza materyali gerektirir), Windows imzalama ve SmartScreen kabulü.
- [ ] Hata mesajları, yardım, araç kategorileri, hızlı başlangıç; dosya yüklemeden/çıkarma yapmadan bağlanma.
- [ ] Kontrat tabanlı tool matrisi: araç adı, parametre, dönüş, hata, kota, güvenlik, OS testleri.

## Kabul kapısı
Her özellik için: (1) GitHub `main` CI PASS, (2) gerçek Agent ↔ Gateway E2E, (3) Windows+Ubuntu+macOS cihaz kabulü (mümkün olan yerde), (4) risk/izin denetimi, (5) sürüm ve kurulum uyumu, (6) fiilî ChatGPT veya Claude istemci testi. CI başarısı tek başına production kabul değildir.

**Farklılaştırma:** Parite kabulünden sonra ayrı faz olarak ele alınacak; mevcut SaaS/gateway mimarisi korunur, kapsam şişirilmez.
