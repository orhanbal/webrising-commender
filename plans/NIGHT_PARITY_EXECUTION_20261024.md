# WECOMMANDER — 24 Ekim 2026 Gece Eşdeğerlik Kapanış Planı

**Amaç:** Desktop Commander'ın temel, gelişmiş ve belgeye özgü araç kapsamına ulaşmak. İşlevler uygulama kodu, MCP şeması, Gateway, yerel Agent, güvenlik ve E2E kabulüyle tamamlanmadıkça DONE denmez.

**Çalışma penceresi:** Europe/Istanbul, 24 Ekim 2026 02.00–08.00 saat başı. Toplam yedi ayrı otomasyon oturumu. Oturumların zamanında veya kesin süre içinde bitmesi garanti değildir; her oturum bir sonraki eksik ve en yüksek riskli işi üstlenir. **Aynı işi iki kez kodlama: her oturumda HEAD/CI/plan kontrolü zorunlu.**

## Saatlik öncelik ve teslimatlar

| Saat | Öncelik | Somut teslim kriteri |
|---|---|---|
| 02.00 | **CI toparlama ve P0 audit** | En son main HEAD, CI logları, ilk kırmızı job; derleme, typecheck ve E2E hatalarını gider. Kırık main bırakma. |
| 03.00 | **P0 arama ve dosya yönetimi** | Doğal dosya ve içerik araması, sayfalama, durdurma/yeniden bağlanma; 1–10 çoklu okuma; satır/tail; atomik düzenleme, conflict guard; parametre/izin/E2E testleri. |
| 04.00 | **P0 terminal ve süreçler** | Büyük çıktı sayfalama, PTY/REPL, süreç yaşam döngüsü ve iptal; çıktıda truncation; Linux E2E, Windows/macOS CI; süreç ağacı temizliği mümkünse regresyon testi. |
| 05.00 | **P1 Excel** | XLSX/XLSM gerçek workbook/worksheet/read/range write; formül/biçim koruma, güvenli atomik çıktı, dosya boyutu sınırları, test fixture. Ücretli/kapalı servis ekleme. |
| 06.00 | **P1 DOCX/PDF ve görsel** | DOCX tablolar/metin, PDF sayfa/metin/birleştirme/düzenleme, görsel metadata/preview; desteklenmeyen platformları açıkça bildir. Her araç için gerçek belge fixture ve negatif test. |
| 07.00 | **P2 UX ve entegrasyon** | MCP connector uyumluluk şeması/olay/hata kontratı; panelde yeni araçları işleyen erişilebilir sayfalar; kurulum/upgrade/uninstall; otomatik UI testleri. |
| 08.00 | **Kapanış ve gerçekçi rapor** | Yeşil CI/Agent E2E, üretilebilir üç OS paketi, tool matrisi, kanıtlar, günlük durum güncellemesi; dışarıda kalmış gerçek cihaz/imzalama testlerini BLOCKED olarak kaydet. |

## Uygulama kuralları

1. Repo **yalnız** `orhanbal/webrising-commender`. Desktop Commander/Remote Desktop Commander uygulaması veya sunucuya Shell/uzaktan komut bağlantısı kullanılmaz. Coolify/production sunucuya müdahale edilmez.
2. Kök mimari korunur: Rust Agent, TypeScript Gateway, PostgreSQL, MCP. Self-hosted ücretsiz çekirdek kısıtlanmaz. Ücretli/kapalı servis, API veya kredi kartı gerektiren bağımlılık ekleme.
3. Farklılaştırma ve yeni SaaS satış özellikleri, eşdeğerlik tamamlanana kadar kapsam dışıdır.
4. Kaynak kodu incelemeden yeni özellik yazma; CI kırmızıysa önce gerçek nedeni düzelt, aynı hatayı tekrarlama.
5. Büyük özellikleri **tek başına başarılı görünen stub** şeklinde kabul etme. MCP araç adı + schema + API + Agent + güvenlik + E2E birlikte olmalı; platforma özel desteğin sınırları açık olmalı.
6. Test sonuçlarını `PASS`, `FAIL`, `PENDING`, `BLOCKED_EXTERNAL` olarak açıkça ayır. Güncel HEAD'in CI'sı geçmişse DONE kabul et, geçmiş bir commit'in sonucunu yeni HEAD'e uygulama.
7. Dosya içeriği, token, kullanıcı bilgisi veya sırları loglama. Okuma/yazma varsayılanı allowlist içinde; yüksek riskli işlemler insan onayından geçer.
8. Gece oturumu sonunda `plans/DESKTOP_COMMANDER_PARITY_PLAN.md` ve bu dosyaya kanıt/commit ekle; kalan ilk engeli ve sıradaki adımı net yaz.

## Başlangıç durumu (01.49 TR)

- main HEAD: `dabc9da31acadac39b85ad5c3e960808b5ab90f6`
- CI: `40036094614` çalışıyor; Rust `Read::by_ref` yöntem belirsizliği en son commit ile düzeltildi, sonucu henüz PASS değil.
- Temel Gateway/Agent/Terminal/Windows whoami testleri mevcut.
- P0 belge dışı araçlar: kısmi kodlandı; bazıları CI kabulü bekliyor.
- P1: Excel/DOCX/PDF özel yerel araçlar henüz açık.
- P2: gerçek ChatGPT/Claude ve fiziksel Ubuntu/macOS kabulü, Windows kod imzası / macOS noter onayı dışarıdan iş birliği gerektirebilir.

## Bitirme tanımı

Tüm maddeleri *kodlandı* diye tamamlandı sayma. `Desktop Commander parity achieved` kararı ancak resmi plan matrisi ve platform kabulünden sonra verilebilir. Harici imzalama ve fiziksel makine testleri kullanıcının erişimini gerektiriyorsa açık kanıt/komutları üret; bunları tamamlanmış saymadan kalan görevleri kodlamaya devam et.
