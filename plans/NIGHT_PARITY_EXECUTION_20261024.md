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

## 04.00 oturumu — P0 PTY çıktı geçmişi (2026-10-24)

- **PASS / giriş HEAD:** `67332a8a`, `ci #40043353106` 17/17 PASS ve platform dağıtımı `#40043712961` PASS.
- **KODLANDI:** `b1500c06` Rust PTY history, `3170bbcd` Gateway mutlak cursor sınırı, `409c089d` MCP sözleşme açıklaması, `9376405c` ve `223798ac` gerçek Agent E2E testi, `912c18bf` Gateway protokol testi, `03ea7026` yarış koşulu düzeltmesi.
- **Kabul sınırı:** `terminal_read` sonrasında `terminal_read_page` çıktı geçmişini koruyor. Pozitif offset mutlak, negatif sondan. 1 MiB retention aşıldığında `truncatedBeforeOffset` ve `retainedStartBytes` raporlanıyor; **tam kalıcı terminal geçmişi hâlâ açık**.
- **CI / PASS:** Kod + ilk plan güncellemesi HEAD `03a618d2` için `ci #40048337156` **17/17 PASS**; son belge düzeltmesinin oluşturduğu HEAD'in CI'sı ayrıca doğrulanmalıdır.
- **AÇIK:** Prompt/REPL tanıma, süreç ağacı temizleme, PTY disk spool ve Agent yeniden başlatması sonrası geçmiş, Windows/macOS fiziksel kabul.
- **Sonraki adım:** CI tamamen yeşilse P0 terminal süreç temizliği açıklarını, ardından P1 Excel desteğini ele al; CI kırmızıysa önce düzelt.

## 05.00 oturumu — P1 XLSX inceleme ve güvenlik (2026-10-24)

- **Giriş HEAD:** `cb97d38f`; `ci #40054203831` kontrol edildi: 15/17 job PASS, Windows/macOS kabul artifact'leri henüz sürüyordu; bu nedenle tüm CI'ya PASS denmedi.
- **Önceden mevcut, tekrarlanmadı:** XLSX/XLSM metadata, 50×20 hücre okuma, 50.000 hücrede arama, XLSX yeni dosyaya 100 hücre düzenleme, SHA-256 önkoşulu ve gerçek Agent E2E fixture.
- **Kodlandı:** `c8a25876` — arama sonucu hücre önizlemesi 4096 UTF-8 baytla sınırlandı; kaydetme bitiminden sonra kaynak SHA-256 tekrar denetlendi. Birim testi Unicode sınırını doğruluyor.
- **E2E test eklendi:** `bc76d202` — 6000+ karakterli XLSX hücresinde geç eşleşme, sonuç önizlemesi ve `valueTruncated` denetimi.
- **Plan güncellemesi:** `ee16dd83` — P1 sınırları ve açık kabul işleri belgelendi.
- **PENDING:** Son HEAD'in CI/Agent E2E ve Windows/macOS paket artifact sonuçları.
- **AÇIK:** XLSM yazma, karmaşık OOXML koruma, formül/stil matrisi, gerçek cihaz kabulü. Öncelik, CI sonucu kırmızıysa düzeltmek; yeşilse 06.00 DOCX/PDF araçlarına geçmek.

## 06.00 oturumu — P1 DOCX okuma ve kabul (2026-10-24)

- **PASS / giriş HEAD:** `12d0a263`, GitHub Actions `ci #40054605923` 17/17 PASS, `platform-distribution #40055044684` PASS.
- **KODLANDI:** Native DOCX `docx_inspect`, `docx_read_paragraphs`, `docx_read_table`; WordprocessingML XML okuma; tablo ve paragraf sayfalama; MCP/Gateway/Rust Agent protokolü ve LOW risk sınıflaması.
- **Güvenlik:** ZIP/XML boyut ve giriş sınırları, allowed-root, dış kaynak veya makro yüklememe, bounded Unicode output.
- **TEST EKLENDİ:** Deterministik DOCX E2E fixture, Unicode ve XML entity çözümleme, tablo ve paragraf pagination, invalid range, missing table, corrupt ZIP ve root dışı erişim reddi.
- **CI / FAIL (düzeltildi):** İlk kod HEAD `be89ed66` için Rust fmt hataları; ardından `fdbc03a2` için Rust clippy `cloned_ref_to_slice_refs` uyarısı. Bunlar `dc60de9f`, `fdbc03a2`, `3236ab30` ile giderildi. Güncel HEAD'in CI sonucu **PENDING**.
- **AÇIK:** DOCX yazma/format koruma, PDF okuma/düzenleme, görsel önizleme, gerçek Windows/macOS/Linux kabulü, Apple noter/Windows imza ve gerçek ChatGPT/Claude istemci testi.
- **Sonraki öncelik:** Yeni CI kırmızıysa düzelt, yeşilse PDF araçları ve görüntü metaveri/önizleme; önceki kodu yeniden yazma.

## Bitirme tanımı

Tüm maddeleri *kodlandı* diye tamamlandı sayma. `Desktop Commander parity achieved` kararı ancak resmi plan matrisi ve platform kabulünden sonra verilebilir. Harici imzalama ve fiziksel makine testleri kullanıcının erişimini gerektiriyorsa açık kanıt/komutları üret; bunları tamamlanmış saymadan kalan görevleri kodlamaya devam et.

## 02.00 oturumu — CI/P0 kabul notu (2026-10-24)

- **PASS / önceki baseline:** `930b5e79` üzerindeki GitHub Actions `ci #40036280462`: 17/17 job başarılı; `platform-distribution #40036735981` başarılı.
- **Kod/test değişikliği:** `97e584f8` — gerçek Linux Agent E2E'de 10 dosya okuma sınırı, 11 dosya reddi, küçük byte limiti, arama oturumu yaşam döngüsü ve geçersiz sayfa negatif testleri.
- **Plan kaydı:** `plans/DESKTOP_COMMANDER_PARITY_PLAN.md` güncellendi; geçmiş PASS ile yeni HEAD testlerini birbirinden ayırıyor.
- **PENDING:** Yeni E2E testlerinin bulunduğu HEAD için GitHub CI; bu not, son HEAD'in PASS olduğunu iddia etmez.
- **P0 açık:** Native gerçek akışlı/askıya alınabilir arama, yeniden başlatma sonrası oturum devamlılığı, tam PTY geçmişi, rollback/sürümleme.
- **BLOCKED_EXTERNAL:** Gerçek ChatGPT/Claude canlı istemci, macOS/Ubuntu fiziksel kurulum ve Windows/macOS kod imzalama kabulü.
- **Sonraki adım:** Önce yeni CI kırmızıysa kök nedeni düzelt; yeşilse 03.00 P0 arama/sayfalama açıklarına geç.

## 03.00 oturumu — P0 arama düzeltmesi (2026-10-24)

- **PASS / giriş HEAD:** `00a5fe63` CI `40037548484` başarılı; platform dağıtımı `40038012018` başarılı.
- **KODLANDI:** Dosya adı aramalarında `case_sensitive` parametresi artık MCP → Gateway → Agent → Rust dosya taramasına aktarılıyor. Önceki sürümde bu parametre dosya aramalarında yok sayılıyordu.
- **KODLANDI:** Gerçek Linux Agent E2E'ye büyük/küçük harf ayrımı ve `start_search` oturumunun aynı semantiği koruması için pozitif/negatif testler eklendi.
- **KODLANDI:** Durdurulan aramaların aktör eşzamanlılık kotasını tüketmesi giderildi; birim testi eklendi.
- **PENDING:** Son kod commit'i `959ed2a4` ve `ci #40043081577` sonucu; belge güncelleme commit'lerinin de ayrıca CI kabulü gerekir.
- **Kalan P0:** Native streaming/pause/cancel, kalıcı search session, tam PTY geçmişi, rollback.
- **BLOCKED_EXTERNAL:** Gerçek macOS/Ubuntu kurulum ve ChatGPT/Claude canlı istemci kabulü.
- **Sonraki öncelik:** Yeni CI hatası varsa düzelt; değilse 04.00 terminal/PTY/süreç yönetimi P0 eksiklerine geç.

## 07.00 oturumu — P1 görsel üstveri aracı / P2 MCP yüzeyi (2026-10-24)

- **PASS / giriş HEAD:** `c3b87ce3` GitHub Actions `ci #40056941079` **17/17 PASS**, `platform-distribution #40057255598` PASS. Böylece 06.00 DOCX okuma ve Agent E2E kabul edildi.
- **KODLANDI, yeni CI bekliyor:** `image_inspect` MCP → Gateway Zod → Rust Agent → allowed-root hattında PNG, JPEG, GIF ve yalnız VP8X WebP header üstverisi (boyut, MIME, dosya boyutu) okur. Yalnızca üstveri; görüntü render/önizleme veya tam dosya doğrulaması **değildir**.
- **Güvenlik:** 32 MiB dosya ve 256 KiB başlık okuma sınırı, dosya uzantısı/içerik eşleşmesi, sıfır veya aşırı boyut reddi, yalnız izinli kök, piksel çözücü yok.
- **TEST EKLENDİ:** Rust header birim testleri, gerçek Linux Agent E2E'de PNG/GIF pozitif, bozuk başlık, sahte JPEG uzantısı ve allowed-root dışı erişim negatif testleri.
- **PENDING:** Bu commit'in tam CI ve üç platform derleme sonucu. CI kırmızıysa 08.00 oturumunda önce hatayı düzelt.
- **AÇIK:** Gerçek görsel önizleme, PDF okuma/düzenleme, DOCX düzenleme, fiziksel platform/ChatGPT/Claude kabulü, macOS notarization ve Windows imzalama.
