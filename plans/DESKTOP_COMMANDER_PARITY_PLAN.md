# WECOMMANDER — Desktop Commander İşlevsel Eşdeğerlik Planı

Son gözden geçirme: 2026-10-24. Öncelik: eşdeğerlik > güvenilirlik/kabul > farklılaşma. Yeni SaaS/ticari özelliklere girilmeden önce aşağıdaki kapsamdaki eksikler kapatılacak.

## Güncel uygulama durumu (2026-10-24 02.00 CI/P0 doğrulaması)
- **CI PASS (kanıt):** `930b5e7931eb9d09b61b97688a6aa92e926ad79b` commit'inde `ci` run `40036280462` içindeki **17/17 job başarıyla tamamlandı** (Rust, Windows/macOS derlemeleri, Linux gerçek Agent E2E, gateway/integration, Compose, Windows service smoke, kurulum syntax, kabul artifact'leri). `platform-distribution` run `40036735981` de başarılı.
- **Yeni test commit'i, henüz kabul değil:** `97e584f8ec7db1829c05bd5bdcf6cf7259e010f4` ile gerçek Agent E2E'ye 10 dosyalı batch, 11 dosyalı negatif sınır, dosya boyutu limiti, asenkron arama oturumu başlat/sonuç sayfalama/durdurma ve geçersiz sayfa testi eklendi. Bu commit'in CI sonucu ayrıca doğrulanmadan PASS sayılmaz.
- **CI'da mevcut P0:** `fs_read_lines` pozitif/negatif satır sayfalama, `fs_read_multiple` (1–10), actor/tenant/cihaz izole arama oturumları, `get_recent_tool_calls`, `get_usage_stats`, `terminal_read_page`, atomik dosya yazma, `fs_append`, `fs_replace` SHA-256 önkoşulu ve `policy_info`. Her birinin kapsamı ilgili testlerin doğruladığı kadar kabul edilir.
- **Kısmi:** Arama oturumları asenkron snapshot sağlar; Agent tarafında gerçek akışlı arama/askıya alma yok. Gateway yeniden başlatıldığında oturumlar kaybolur. PTY çıktı geçmişi son 1 MiB ile sınırlıdır; kalıcı tam çıktı sayfalama yok. Atomik yazma mevcut olsa da otomatik rollback/sürümleme yok.
- **Açık:** Excel/DOCX/PDF formatlarına özel araçlar, gerçek ChatGPT/Claude MCP kabulü, üç OS fiziksel kabulü, platform imzalama/noter, kullanıcı paneli tam işlev kabulü.
- `main` HEAD her zaman kabul edilmiş sürüm değildir. Her yeni commit'in CI sonucu ve Agent E2E kanıtı ayrıca doğrulanır.

## 03.00 P0 arama güvenilirliği — uygulanan düzeltme (2026-10-24)

- **Önceki kanıtlı baseline:** `00a5fe63` üzerinde `ci #40037548484` PASS ve `platform-distribution #40038012018` PASS.
- **KODLANDI / güncel HEAD CI bekliyor:** Native `fs_search` daha önce her zaman küçük/büyük harfe duyarsızdı; `start_search(search_type=files, case_sensitive=true)` parametresi sessizce yok sayılıyordu. Rust `AgentAction`, dosya arama fonksiyonu, Gateway Zod protokolü, MCP şeması ve oturum yönlendirmesinde `caseSensitive` uçtan uca geçiriliyor; varsayılan eski davranış (`false`) korunuyor.
- **KODLANDI / test eklendi:** Gerçek Agent MCP E2E'de `CaseMatch.txt` / `casematch.txt` ayrımı ve oturum sonuç sayfalaması; Gateway unit testinde arama parametresi iletimi.
- **KODLANDI / test eklendi:** `stop_search` ile durdurulan oturumun aynı kullanıcı için eşzamanlılık kotasını tüketmemesi, global limit dolduğunda durmuş oturumların geri kazanılması. Durmuş oturumun sayfalı durum sorgusu geçici süre boyunca korunur.
- **PENDING:** Güncel kod HEAD `959ed2a4` için GitHub Actions CI run `40043081577` başlatıldı; sonucu görülmeden kabul PASS değildir.
- **AÇIK:** Gerçek native akışlı arama ve iptal, yeniden başlatmada oturum devamlılığı, kalıcı terminal geçmişi ve sürüm/rollback. `stop_search` şu an yalnızca Gateway sonuçlarını durdurur; devam eden native taramayı fiziksel olarak iptal etmez.

## 04.00 P0 terminal geçmişi ve sayfalama (2026-10-24)

- **PASS / giriş HEAD:** `67332a8a` için `ci #40043353106` 17/17 ve platform dağıtımı `#40043712961` başarılı.
- **KODLANDI:** Rust Agent PTY çıktısında tüketici `terminal_read` kuyruğu ile bağımsız, 1 MiB sınırlı, non-consuming `terminal_read_page` geçmişi. `terminal_read` geçmişi artık silmiyor; pozitif offset tüm PTY akışındaki mutlak bayt konumunu, negatif offset sondan okumayı gösteriyor.
- **KODLANDI:** Taşma sonrası `retainedStartBytes`, `totalOutputBytes`, `truncatedBeforeOffset` alanları ile eksik geçmiş açıkça bildiriliyor. `nextOffsetBytes` mutlak imleçtir. MCP açıklaması ve Gateway güvenli tamsayı doğrulaması güncellendi.
- **TEST:** Rust unit testi taşma, tail, mutlak sayfalama; gerçek Linux Agent E2E testi `terminal_read` sonrası geçmişin korunması ve mutlak imleçten yeniden okuma; Gateway protokol testi büyük mutlak offset ve güvenli tamsayı sınırı.
- **CI / PASS:** Kod + plan güncellemesi HEAD `03a618d2` için GitHub Actions `ci #40048337156` **17/17 PASS** (Rust, Gateway, Linux Agent E2E, Windows/macOS derlemeleri, installer/artifact işleri ve güvenlik entegrasyonu). Bu belge güncellemesi yeni HEAD oluşturacağı için onun CI'sı ayrıca doğrulanmalıdır.
- **AÇIK:** Geçmiş yalnızca Agent RAM'inde ve 1 MiB sınırında; Agent yeniden başlatması sonrası veya daha eski çıktı için disk tabanlı tam geçmiş yok. REPL/prompt algılama, process-tree cleanup, native search cancellation ve gerçek üç platform kabulü ayrıca açık.

## 05.00 P1 Excel / XLSX güvenlik ve regresyon (2026-10-24)

- **Kodlandı, güncel HEAD CI bekliyor:** `xlsx_inspect`, `xlsx_read_range`, `xlsx_find` ve `xlsx_write_cells` MCP → Gateway → native Rust Agent hattında mevcut. Gerçek Linux Agent E2E, XLSX okuma/arama ve yeni XLSX'e hücre düzenleme, kaynak hash önkoşulu, makro etkin XLSM düzenleme reddi, mevcut çıktı dosyasını ezmeme ve izin sınırlarını test ediyor.
- **Güvenlik düzeltmesi:** `c8a25876` arama eşleşmesindeki hücre içeriğini UTF-8 sınırlarını koruyarak en fazla 4096 bayt önizleme olarak döndürür ve `valueTruncated` alanını ekler. Önceden tek bir büyük hücre sınırsız MCP arama sonucu üretebiliyordu.
- **Eşzamanlı düzenleme düzeltmesi:** Aynı commit, XLSX kaydetme işlemi tamamlandıktan sonra, yeni dosya atomik yayımlanmadan hemen önce kaynak SHA-256 değerini yeniden denetler. Kaynak arada değişmişse yeni çıktı yayımlanmaz. Bu, tüm olası dosya sistemi yarışlarını ortadan kaldırdığı iddiası değildir.
- **Gerçek Agent E2E testi:** `bc76d202`, 6000+ karakterli XLSX hücresinin sonunda bulunan metni arar ve yanıttaki `valueTruncated=true` ile 4096 bayt önizleme sınırını doğrular.
- **PENDING:** Bu son iki kod/test commit'inin CI ve dağıtım kabulü; en son HEAD üzerinde bütün job'lar PASS olmadan tamamlandı sayılmaz.
- **AÇIK:** XLSM güvenli yazma (şimdilik yalnızca okuma), karmaşık OOXML parçaları için yazma (bilinçli olarak reddediliyor), formül ve stil roundtrip matrisi, fiziksel Windows/macOS kabulü ve performans testleri.

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
