## 24 Ekim 2026 — A/B/C/D: native dosya okuma symlink yarışını sertleştirme

- **A / PASSED (giriş kodu):** [CI #40110624425](https://github.com/orhanbal/webrising-commender/actions/runs/40110624425) / `54c4ee7c` 17/17 PASSED; önceki kırmızı `integration` SMTP outbox yarışı giderilmişti. Bu kanıt yeni kod commitlerine taşınmaz.
- **B / KODLANDI, PENDING:** [`c8cb2438`](https://github.com/orhanbal/webrising-commender/commit/c8cb2438848db12766cf18c71108991e1f9f8602) Rust Agent'da `text_search`, `fs_read`, `fs_read_lines` ve `fs_replace` için normal dosya handle'ı ve son bileşen symlink izlememe koruması ekler (Linux `O_NOFOLLOW`, macOS `O_NOFOLLOW`, Windows reparse-point açma bayrağı). `fs_replace` içeriği artık 4 MiB + 1 bayt fiziksel sınırla okur; metadata/read büyüme yarışında bellek sınırsız büyümez. Ücretli veya yeni runtime bağımlılığı yok.
- **C / TESTLER KODLANDI, PENDING:** [`d7e47d93`](https://github.com/orhanbal/webrising-commender/commit/d7e47d934faaa14ad8adab41334bd663b69791b2) gerçek MCP→Gateway→Rust Agent E2E'de allowlist dışı dosyaya symlink üzerinden `fs_read`, `fs_read_lines`, `fs_replace` reddini ve hedef içeriğinin değişmemesini doğrular. Rust unit final-component swap simülasyonu eklenmiştir.
- **D / FAILED → FIXED CODE, CI PENDING:** [CI #40111108878](https://github.com/orhanbal/webrising-commender/actions/runs/40111108878) `rust` job `cargo fmt --check` biçim hatası gösterdi. [`7567af97`](https://github.com/orhanbal/webrising-commender/commit/7567af97d4dc6b6dea05771a75b99468a47be0d3) bu diff'i düzeltti; [CI #40111188325](https://github.com/orhanbal/webrising-commender/actions/runs/40111188325) son kodun 17 job sonucu ve artifact'leri tamamlanmadan **PASSED** sayılmaz. Bu belge commitinin kendi CI'sı da ayrıca kontrol edilir.
- **Kalan risk ve kuyruk:** Bu koruma yalnız son path bileşeninin symlink değiştirilmesini sınırlar; üst dizinlerin eşzamanlı yeniden adlandırılması için descriptor-relative/openat benzeri tam yarış güvenliği henüz **PENDING**. **1A** gerçek native streaming/pause/resume; **1B** çalışan taramayı checkpoint'ten restart sonrası sürdürme; **1C/1D/3A** tam OS/stress/race kabulü **PENDING**. 2A–10D kuyruğu açık; **7B/10C BLOCKED_EXTERNAL**. Tam Desktop Commander eşdeğerliği **PENDING**.
- **Kapsam:** Yalnız `orhanbal/webrising-commender/main`; başka repo, üretim, sunucu, Desktop Commander/Remote Desktop Commander kullanılmadı.

## 24 Ekim 2026 19.14 TRT — A: kırmızı CI düzeltildi, 1A/1B kabulü açık

- **FAILED (giriş HEAD):** `55da5480db6bcb007df286a502e8f523be22fa5e`, [CI #40108369178](https://github.com/orhanbal/webrising-commender/actions/runs/40108369178): 16/17 job PASSED; `integration` FAILED. Gerçek job `120914763009` logunda `gateway/test/integration.mjs:241` `outboxStatus.counts.sent >= 1` assertion hatası. SMTP test sunucusu mesajı kaydetmişti, ancak asenkron mail worker'ın `sent_at` veritabanı güncellemesi henüz görünür değildi.
- **FIX COMMITTED:** [`54c4ee7c`](https://github.com/orhanbal/webrising-commender/commit/54c4ee7c998f029e47d44826de0c7317ca98b7b8) yalnız `gateway/test/integration.mjs` testindeki gönderim durumunu `waitFor` ile en çok 8 saniye bekler; güvenlik assertion'ları, gerçek SMTP gönderimi ve veritabanı kalıcılığı kontrolü korunur. Runtime davranışı veya araç şeması değiştirilmedi.
- **PASSED (düzeltme kod HEAD'i):** [CI #40110624425](https://github.com/orhanbal/webrising-commender/actions/runs/40110624425), `54c4ee7c998f029e47d44826de0c7317ca98b7b8`: **17/17 job success** (`integration`, `gateway`, `agent-e2e`, `rust`, `relay-e2e`, OS build/smoke). Dört artifact: `dashboard-visual-acceptance`, `WECOMMANDER-linux-x64-acceptance`, `WECOMMANDER-macos-universal-acceptance`, `WECOMMANDER-windows-x64-acceptance` (hepsi non-expired).
- **B/C — PENDING:** Bu çalışmada girişte kritik kırmızı CI bulunduğundan 1A streaming/pause-resume veya 1B restart-checkpoint üzerinde doğrulanmamış yeni özellik yazılmadı. 1A/1B birinci sırada kalır; 1C fiziksel stres kabulü ve 1D–10D sonraki kuyruktadır. 46 MCP araç sözleşmesi değişmedi.
- **D — PENDING (bu doküman HEAD'i):** Yukarıdaki 17/17 yalnız `54c4ee7c` kod HEAD'i içindir; bu belge commitinin kendi CI'sı ayrıca doğrulanmalıdır. Fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imza/SmartScreen ve Apple notarization **BLOCKED_EXTERNAL**. Tam parity **PENDING**.
- **Kapsam:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer repo/Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli/sınırlı runtime eklenmedi.

## 24 Ekim 2026 — 1C: çoklu Gateway ortak native arama kotası

- **A / MEVCUT KOD:** [a33ec3d6](https://github.com/orhanbal/webrising-commender/commit/a33ec3d6f7dd0e8ceea28fba6f97f5f86c7e183a) aynı organizasyon/kullanıcının farklı cihazlarda tek bir eşzamanlı arama kotasını paylaşmasını sağlar; [1b79899a](https://github.com/orhanbal/webrising-commender/commit/1b79899a784e3a3a8352ecba986d073884cb04c1) sınır, tenant izolasyonu ve durdurma yarışı unit testini ekler. Gateway job logunda unit test PASSED kanıtı görüldü; ilgili kod HEAD'i daha sonra dokümantasyon commitleriyle değişti.
- **B / DAĞITIK DÜZELTME KODLANDI:** [f13b3f6b](https://github.com/orhanbal/webrising-commender/commit/f13b3f6b1b4835bfe2eec33bd09e4147685e6f73) PostgreSQL transaction + advisory actor lock ile **Gateway'ler arası sekiz eşzamanlı native işlem** kotasını uygular. `native_inflight` alanı durdurulan işlemin fiziksel sonucuna kadar kotada kalmasını sağlar. Durum geçişleri aynı actor/organization/device kapsamında SQL CAS ve explicit native settlement ile korunur; ölü Gateway için 15 saniyelik heartbeat lease kullanılır.
- **C / GERÇEK POSTGRESQL E2E:** İlk [CI #40107913863](https://github.com/orhanbal/webrising-commender/actions/runs/40107913863) entegrasyon işi, test harness'ının `pg.Client` üzerinde tekrar connect denemesi nedeniyle FAILED. [cd339dda](https://github.com/orhanbal/webrising-commender/commit/cd339dda1ffc21bf8f74c5592f1ec2ea14755fcc) testte gerçek `pg.Pool` kullanır ve iki farklı Gateway persistence instance'ıyla 8 aktif tarama, 9. ret, stop sonrası slotun korunması ve native settlement sonrası yeni tarama kabulünü doğrular. [CI #40108057584](https://github.com/orhanbal/webrising-commender/actions/runs/40108057584) üzerinde `gateway` ve `integration` job'ları **PASSED** görüldü; bütün CI tamamlanmadan **17/17 PASSED** ilan edilmez.
- **D / PENDING:** Bu doküman commitinin son HEAD CI'sı ayrıca beklenir. 1C fiziksel OS, yüksek eşzamanlılık ve stres kabulü hâlâ PENDING. **1A** native canlı streaming/pause/resume ve **1B** çalışan native taramayı checkpoint'inden Gateway restart sonrası sürdürme henüz uygulanmadı; 1D–10D kanonik kuyruk açık. **7B/10C BLOCKED_EXTERNAL** (fiziksel OS, canlı ChatGPT/Claude, Windows imzalama/SmartScreen, Apple notarization). Genel Desktop Commander parity **PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; diğer repo, üretim sunucusu ve Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 — 1C: kullanıcı başına eşzamanlı arama kotası (çoklu cihaz)

- **A / DOĞRULANDI:** Önceki native Rust biçimlendirme hatası [6ae9f2c5](https://github.com/orhanbal/webrising-commender/commit/6ae9f2c5d136944f4b2ece86dc6d8e16f78e3329) ile düzeltilmiş; eski [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) FAILED sonucu daha yeni HEAD için kabul değildir.
- **B / 1C KODLANDI:** [a33ec3d6](https://github.com/orhanbal/webrising-commender/commit/a33ec3d6f7dd0e8ceea28fba6f97f5f86c7e183a) Gateway içi aktif native arama kotasını kullanıcı-cihaz yerine **organizasyon + kullanıcı** düzeyinde uygular. Aynı kullanıcının cihaz değiştirerek sekiz eşzamanlı arama kotasını aşması engellenir. Durdurulmuş fakat Agent yanıtı henüz tamamlanmamış aramalar slot işgal etmeye devam eder.
- **C / REGRESYON EKLENDİ:** [1b79899a](https://github.com/orhanbal/webrising-commender/commit/1b79899a784e3a3a8352ecba986d073884cb04c1) aynı kullanıcı + dokuzuncu cihaz için ret, farklı kullanıcı/organizasyon izolasyonu, durdurulan yerel taramanın slotunun erken boşalmaması ve settle sonrası yeni oturum testleri ekler. Önceki 1C timeout regresyonları [49372753](https://github.com/orhanbal/webrising-commender/commit/49372753ff744fb5647a1236f693dd1c113c0b2e) ve [52416147](https://github.com/orhanbal/webrising-commender/commit/52416147e141cb0b6cd24509d669596009bb23b3) kayıtlıdır.
- **D / CI PENDING:** Kod HEAD'i `1b79899a784e3a3a8352ecba986d073884cb04c1` için [CI #40107310735](https://github.com/orhanbal/webrising-commender/actions/runs/40107310735) başlatıldı; tüm işler tamamlanmadan PASSED denmeyecek. Bu plan commitinin kendi HEAD CI'sı ayrı doğrulanmalıdır.
- **Açık kabul:** Çoklu Gateway üzerinden **dağıtık kota** henüz uygulanmadı; 1C'nin OS/stres/race kabulü PENDING. **1A** native gerçek zamanlı streaming ve pause/resume, **1B** çalışmakta olan taramayı restart sonrası checkpoint'ten sürdürme PENDING. 1D–10D kuyruk görevleri açık; 7B/10C fiziksel OS, canlı ChatGPT/Claude ve imzalama/noter kanıtı BLOCKED_EXTERNAL. Desktop Commander işlevsel eşdeğerliği PENDING.
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; diğer depolara, üretim sunucularına veya Remote Desktop Commander'a dokunulmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 18.20 TRT — A/B/C/D: dayanıklı arama sayfalama ve native silinme yarışı

- **A / PASSED (giriş HEAD):** `58829a87d0926b6fa9387053856e5c6c57ad3ed3` üzerinde [CI #40101907731](https://github.com/orhanbal/webrising-commender/actions/runs/40101907731) **17/17 PASSED**, [platform #40102369794](https://github.com/orhanbal/webrising-commender/actions/runs/40102369794) **PASSED**. Gerçek `rust`, `agent-e2e`, `gateway` job sonuçları/logları okundu. Bu kanıt yeni HEAD'e taşınmaz.
- **B / 1D PENDING (gerçek düzeltme):** [`771327d4`](https://github.com/orhanbal/webrising-commender/commit/771327d4ad8156526faf08466caa802bd43913d7) PostgreSQL kalıcı arama sonuçları 1 MiB sınırını aştığında tüm sayfaları sıfırlamak yerine UTF-8 byte hesabıyla en uzun **sıralı öneki** tutar; `truncated=true`, 500 sonuç sınırı, actor/tenant/device ve CAS stop koruması değişmez. [`b7e89f6c`](https://github.com/orhanbal/webrising-commender/commit/b7e89f6c152200c5bd7ce9e62e12719d805d3b34) TypeScript UTF-8/500-item/korunan-sıra negatif testleri; [`2dadd539`](https://github.com/orhanbal/webrising-commender/commit/2dadd539533867baeea303096c41e05598772b7d) gerçek PostgreSQL restart-benzeri sayfalama, son sayfa ve stop sonrası veri silinmesi E2E testi ekler.
- **C / 1C PENDING (native yarış düzeltmesi):** [`40c0c1fc`](https://github.com/orhanbal/webrising-commender/commit/40c0c1fc0fa315bf5c132c42d35e6a0b5d459d15) Rust `fs_search` ve `text_search` sırasında `read_dir`/metadata arasında silinen girdileri atlar; diğer IO/izin hatalarını saklamaz, symlink izlemez. Deterministik silinmiş dosya unit regresyonu eklendi. Çoklu OS/stres kabulü açık.
- **D / PENDING (yeni HEAD):** [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) yeni kod için başlatıldı; tüm 17 job ve artifact'ler tamamlanmadan **PASSED** yazılmaz. Bu belge commitinin HEAD CI'sı ayrıca kontrol edilecek.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve gerçek uzun tarama kabulü), **1B PENDING** (çalışan taramanın Gateway restart sonrası kaldığı yerden devamı), **1C PENDING**, **1D PENDING** (geniş OS/stress/çıktı kabulü). **2A–10D PENDING** kanonik kuyrukta, **7B/10C BLOCKED_EXTERNAL** fiziksel OS, canlı ChatGPT/Claude, Windows imza/SmartScreen, Apple notarization. **Eşdeğerlik PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 17.18 TRT — A/B/C/D, 1A native içerik iptali ve 1D bounded dosya okuma

- **A — PASSED (giriş):** Başlangıç HEAD `93c926cc` için [CI #40098399194](https://github.com/orhanbal/webrising-commender/actions/runs/40098399194) **17/17 PASSED**, [platform #40098783921](https://github.com/orhanbal/webrising-commender/actions/runs/40098783921) **PASSED**; `rust`, `agent-e2e`, `gateway` job logları okundu. İlk yeni kodun `rust` job'ı `cargo fmt --check` nedeniyle FAILED; gerçek rustfmt diff'i `f74f7655` ile düzeltildi, **son HEAD CI PENDING**.
- **B — 1A PENDING (gerçek Rust iyileştirmesi):** [`b4bb67e7`](https://github.com/orhanbal/webrising-commender/commit/b4bb67e728ea7531b28fad8ed794ba62aeaa1068) içerik taramasındaki tek seferlik `read_to_string` yerine 16 KiB parçalarda, aralarda `AtomicBool` iptali ve monotonic deadline kontrolü yapan en çok 1 MiB okuma getirdi. İptalin dosya okunurken gerçekleşmesini taklit eden deterministik Rust unit eklendi. **Native progress streaming, pause/resume ve uzun gerçek tarama benchmark'ı hâlâ PENDING; 1A tamamlandı sayılmaz.**
- **C — 1D PENDING (bounded okuma + negatif E2E):** `fs_read_lines` için metadata ile gerçek okuma arasındaki büyüme yarışında 32 MiB + 1 bayt fiziksel sınır eklendi. [`f1c5b4ec`](https://github.com/orhanbal/webrising-commender/commit/f1c5b4ec1d25dee2331b1351061856b6a2235f07) ve [`6c541773`](https://github.com/orhanbal/webrising-commender/commit/6c541773f70d52103f881f1b575ba1dd5d98665f) gerçek MCP → Gateway → Agent E2E'de içerik araması 1 MiB sınırı, 32 MiB paged-read reddi ve bozuk UTF-8 reddi ekledi. Mevcut 46 MCP araç şeması, allowlist ve actor/tenant/device denetimi korunur; yeni araç veya ücretli bağımlılık yok.
- **D — PENDING:** [`f74f7655`](https://github.com/orhanbal/webrising-commender/commit/f74f7655b8d90235da3925add2a907b3cd789e5b) rustfmt düzeltmesi. [CI #40101863534](https://github.com/orhanbal/webrising-commender/actions/runs/40101863534) kod HEAD'i için başlatıldı; tüm job/artefact sonucu görülmeden PASSED yazılmaz. Bu plan commitinin kendi HEAD CI'sı ayrıca denetlenecek.
- **Kuyruk:** **1A PENDING**, **1B PENDING** (çalışan tarama restart sonrası kaldığı yerden devam etmiyor), **1C PENDING**, **1D PENDING** (OS/stress/büyük çıktı kabulü açık); **1D–10D** diğer açık işler mevcut kanonik kuyrukta. **7B/10C BLOCKED_EXTERNAL** (fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imza ve Apple notarization). **Eşdeğerlik PENDING.**
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; üretim/sunucu/başka repo/Desktop Commander/Remote Desktop Commander kullanılmadı.

## 24 Ekim 2026 16:22 TRT — A/B/C/D: native multi-file read, güvenlik ve CI düzeltmesi

- **A — PASSED (giriş):** `02ee2ab3` üzerinde [CI #40093405056](https://github.com/orhanbal/webrising-commender/actions/runs/40093405056) **17/17 PASSED**, [platform #40093754504](https://github.com/orhanbal/webrising-commender/actions/runs/40093754504) **PASSED**. `rust`, `agent-e2e` ve `integration` logları incelendi; eski CI sonucu yeni HEAD'e aktarılmadı.
- **B — 1D IMPLEMENTED, kabul PENDING:** [`b4587f9e`](https://github.com/orhanbal/webrising-commender/commit/b4587f9e3dd1f3e7c7ad806328456a570af78706) `fs_read_multiple` için 1–10 dosyayı **tek native Rust Agent çağrısıyla** okuyan bounded yol ekler. MCP şeması, TypeScript action validation/risk, Agent enum/risk/allowlist, native read ve E2E uyumludur; her dosyanın hatası ayrı döner. Gateway'in önceki 10 ayrı Agent isteği kaldırıldı. Dosya başına 64 KiB sınır ve redakte `read_failed` kodu uygulanır. Araç sayısı değişmez (**46**).
- **C — TESTS ADDED, CI PENDING:** Gerçek Agent MCP E2E'de 10 dosya, kısmi hata, allowlist dışı yolun sızdırılmaması, sıfır/11 dosya, limit aşımı ve okuma sınırı; TypeScript Zod negatif kontrat testleri eklendi. Bunlar ilgili HEAD CI tamamlanmadan PASSED değildir.
- **D — CI FIX / PENDING:** İlk kod HEAD'i [CI #40097800013](https://github.com/orhanbal/webrising-commender/actions/runs/40097800013) `cargo fmt --check` adımında **FAILED**; gerçek diff incelenip [`36964592`](https://github.com/orhanbal/webrising-commender/commit/36964592a4c034f07ab9cc22a758bcf7c697dc07) ile Rust biçimi düzeltildi. [CI #40097863619](https://github.com/orhanbal/webrising-commender/actions/runs/40097863619) yeni kod HEAD'inin sonucudur; tam 17 iş, platform artifact ve bu dokümantasyon commitinin son HEAD CI'sı ayrıca kontrol edilmelidir.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve uzun tarama iptal kabulü); **1B PENDING** (çalışan taramanın restart sonrası sürdürülmesi); **1C PENDING** (OS/stress/race); **1D PENDING** (yeni native batch CI/OS kabulü ve satır/büyük çıktı uçları). **7B/10C BLOCKED_EXTERNAL**; diğer 1D–10D eksikler kuyrukta. **Genel eşdeğerlik PENDING.**
- **Kapsam:** Sadece `orhanbal/webrising-commender/main`; üretim, sunucu, başka repo, Desktop Commander veya Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 — A/B/C/D gerçek Agent arama regresyonları (15.17 TRT)

- **A — PASSED (giriş HEAD):** `b222da7a` [CI #40091796139](https://github.com/orhanbal/webrising-commender/actions/runs/40091796139) **17/17 PASSED**, [platform #40092082366](https://github.com/orhanbal/webrising-commender/actions/runs/40092082366) **PASSED**. `agent-e2e`, Rust ve Gateway job sonuçları/logları incelendi. Bu sonuçlar yeni commitlere taşınmaz.
- **B — 1A PENDING (test eklendi):** [`4ed6397b`](https://github.com/orhanbal/webrising-commender/commit/4ed6397bd11185f644a37d10ae2a6c450812f3f4) gerçek Rust Agent üzerinden **iki eşzamanlı `start_search` oturumu**, birini `stop_search` ile durdurma, diğerinin 500 sonuçla tamamlanması ve durdurulmuş oturumun sonuçlarının yeniden görünmemesi için MCP E2E regresyonu ekler. Bu test **gerçek streaming, pause/resume veya fiziksel native iptal gecikmesini kanıtlamaz**.
- **C — 1C PENDING (test eklendi):** [`31e3770a`](https://github.com/orhanbal/webrising-commender/commit/31e3770a00044337c7be530e53d36edb129fe4d8) doğrudan `text_search` ve sayfalı `start_search` üzerinde case-sensitive/insensitive içerik eşleşmesinin Rust Agent'da ayrışmasını test eder.
- **D — PENDING (güncel HEAD kabulü):** Kod commitleri için [CI #40093329014](https://github.com/orhanbal/webrising-commender/actions/runs/40093329014) ve [CI #40093339478](https://github.com/orhanbal/webrising-commender/actions/runs/40093339478) tetiklendi; dokümantasyon commitinin kendi CI'sı ayrıca doğrulanır. **17/17 PASSED** yalnız `b222da7a` için kanıtlıdır. Son HEAD testleri geçene kadar yeni kapsam **PENDING**.
- **Kuyruk:** 1A streaming/pause/resume ve uzun tarama gerçek native iptal; 1B çalışan taramanın restart sonrası devamı; 1C OS/stress/race; 1D–10D açık. 7B/10C canlı ChatGPT/Claude, fiziksel OS ve imzalama/noter **BLOCKED_EXTERNAL**. **Genel eşdeğerlik PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim, sunucu, başka depo, Desktop Commander ve Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim — 1C büyük dizin / güvenli arama kabulü

- **Giriş kabulü:** `e7256adc` [CI #40088982183](https://github.com/orhanbal/webrising-commender/actions/runs/40088982183) **17/17 PASSED**, [platform #40089288689](https://github.com/orhanbal/webrising-commender/actions/runs/40089288689) PASSED.
- **1C — kodlanan test paketi:** `7b101537` ile gerçek Rust Agent E2E'de **530 dosya**, maksimum **500 sonuç**, `truncated`, son 10 sonuçta offset 490/length 30, son sayfa `hasMore=false`, uygunsuz offset, 101 eleman uzunluğu ve 1025 karakter sorgu negatif kontrolleri eklendi. [CI #40091456300](https://github.com/orhanbal/webrising-commender/actions/runs/40091456300) içinde `agent-e2e`, `gateway`, `integration` işleri PASS; bütün CI ve artifact kontrolü sürüm HEAD'ine göre ayrıca teyit edilir.
- **1C — bu belgeyle birlikte yeni negatif test:** İzin verilen arama kökünden dışarıdaki dizine işaret eden symlink üzerinden dosya adı veya içerik sorgusunun dış veri döndürmemesi; fiziksel Linux Agent E2E koşusu yeni HEAD CI sonucuna tabidir. Üretim/sunucular test edilmedi.
- **Kalan:** 1A gerçek native streaming ve pause/resume; 1B yeniden başlatmadan sonra *çalışan taramayı* sürdürebilme; 1C kalan çoklu OS/stress/race kabulü; 1D–10D ana görev kuyruğu **PENDING**. Gerçek ChatGPT/Claude ve fiziksel cihaz onayı **BLOCKED_EXTERNAL**. **Genel eşdeğerlik PENDING**.

## 24 Ekim 14:11 TRT — A/B/C/D, cross-Gateway native search cancellation

- **A / PASSED (giriş):** `e53f30ef` [CI #40088408188](https://github.com/orhanbal/webrising-commender/actions/runs/40088408188) **17/17 PASSED**; [platform #40088728355](https://github.com/orhanbal/webrising-commender/actions/runs/40088728355) PASSED. `0fb9254c` gerçek Gateway SIGKILL/restart E2E testini CI'ya ekledi; bu yeni testin kendi CI'sı ayrı doğrulanır.
- **B / IMPLEMENTED, CI PENDING (1B kalan dilim):** `1dd8091f` `PgSearchPersistence.stoppedIds` ile yalnız **aynı origin_instance** ve aktif UUID kümesine ait, DB'de durdurulmuş aramaları döndürür. Başka Gateway üzerinden `stop_search` sonrası owning Gateway saniyelik tek toplu sorguyla `AbortController` iptalini gerçek native/relay zincirine iletir. DB kesintisinde native zaman sınırı devam eder; tamamlanmış sonuçları diriltmeye izin verilmez.
- **C / TESTS ADDED:** Unit: yanlış ID başka aramayı iptal etmez; doğru ID yalnız ilgili native sinyali iptal eder; boş küme DB sorgusu yapmaz; SQL origin guard doğrulanır. PostgreSQL integration: farklı store üzerinden stop → owning store stoppedIds doğrulanır. **Canlı iki Gateway + gerçek Rust Agent uzun tarama iptal benchmark'ı henüz yok.**
- **D / PENDING:** [Kod HEAD CI #40088922971](https://github.com/orhanbal/webrising-commender/actions/runs/40088922971) yeni commit için başlatıldı; tüm 17 iş ve artifact'ler tamamlanmadan PASSED yazılmaz. Bu doküman commitinin de ayrı HEAD CI sonucu kontrol edilir.
- **Kuyruk:** **1A PENDING** (gerçek streaming/pause/resume eksik); **1B PENDING** (completed snapshot restart sürekliliği mevcut; çalışan scanner restart sonrası kaldığı yerden başlamıyor); **1C–10D** diğer açık kabul kapıları değişmedi. **7B/10C BLOCKED_EXTERNAL** (canlı istemciler, fiziksel OS, imzalama/noter). **Eşdeğerlik PENDING.**
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander araçları kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim — P0 1B PostgreSQL arama oturumu kalıcılığı

- **A / baseline:** Önceki tam doğrulanan `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) **17/17 PASS** ve [platform #40086302889](https://github.com/orhanbal/webrising-commender/actions/runs/40086302889) PASS. Daha yeni HEAD'e bu sonucu taşımayın.
- **B / IMPLEMENTED, CI PENDING:** `fc51c76c` PostgreSQL `search_sessions` migration, actor/organization/device-scoped 5dk TTL, en fazla 500 eşleşme ve 1MiB kalıcı sonuç sınırı, error/stop kayıtları ve housekeeping. `start_search`, `get_more_search_results`, `list_searches`, `stop_search` persistent fallback kullanır. Çalışır durumdaki native scanner otomatik devam ettirilmez; yeniden başlatılmış Gateway'in sahip olmadığı `running` iş `search_interrupted` görünür.
- **C / TESTS ADDED, CI PENDING:** `f70a13ed` async search-page/stop/list kontratı ve TypeScript unit; `c9dbfe2e` izolasyon/rollback/sınır mock regresyonu; `1e0d6dc2` gerçek PostgreSQL integration: tamamlanmış aramayı yeni store örneğinden okumak, actor/tenant/device negatif izolasyon, stop sonrası temizleme, yarım taramayı `search_interrupted` gösterme.
- **D / PENDING:** Son doküman HEAD'inin 17/17 CI ve dağıtım artifact kabulü, gerçek Gateway sürecini kapatıp açan uçtan uca restart senaryosu, çoklu Gateway/failover eşzamanlı durdurma, uzun bölgesel native cancellation ve 1A streaming/pause kabulü açık. **Eşdeğerlik ilan edilmez.**
- **BLOCKED_EXTERNAL:** Fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, platform imzaları ve Apple notarization kanıtlanmadı.

## 24 Ekim — Bölgesel relay arama iptali (1A, A/B/C/D)

- **A:** Giriş `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) 17/17 başarılı; üretim, fiziksel cihaz ve dış MCP kabulü yapılmadı.
- **B:** `91506f9e` — `DeviceRouter` bölgesel relay isteklerine eşsiz UUID ekler; `AbortSignal` geldiğinde ayrı **imzalı** `/internal/relay/cancel` çağrısını kullanır. Uzak `AgentHub` cancel sinyalini native Agent'a iletir. Asıl HTTP isteği kooperatif bitişe kadar bekler; eşzamanlı tarama kotası erken boşaltılmaz.
- **C:** `relay-cancellation.ts` — farklı sırada ulaşan cancel/request çağrıları için TTL'li ve kapasiteli erken iptal kaydı; `requestId + deviceId` eşleşmesi, çakışma ve yanlış cihaz testleri. Bölgesel relay E2E'ye unsigned cancel=401, gerçek MCP start/stop/page yarış testi eklendi.
- **D:** Bu belge güncellemesinin **yeni HEAD CI sonucu PENDING**. Canlı uzun süren bölgesel arama üzerinde iptal süre/maliyet benchmark'ı, streaming ve pause/resume ile 1B kalıcı oturum **PENDING**; genel eşdeğerlik **PENDING**. 

## 13.11–13.25 A/B/C/D ilerleme kaydı — 24 Ekim 2026

- **A / PASSED (giriş):** `7d4ff46b` için [CI #40081678744](https://github.com/orhanbal/webrising-commender/actions/runs/40081678744) **17/17 PASS**; [platform #40082053980](https://github.com/orhanbal/webrising-commender/actions/runs/40082053980) PASS. Rust, Agent E2E ve integration job logları incelendi; giriş HEAD'inde kırmızı iş yoktu.
- **B / PENDING (1A native cancellation):** `c602a7ad` ile Rust Agent aramaları `spawn_blocking` üzerinde çalışıyor; istek bazlı `AtomicBool` iptal bayrağı tarama döngüsü/dizin/satır sınırlarında kontrol ediliyor. WebSocket `cancel` geldiğinde search task'ı körlemesine abort edilmek yerine kooperatif çıkış yapıyor; disconnect/shutdown bayrakları temizliyor. Pre-cancelled Rust negatif testi eklendi.
- **C / PENDING (1A Gateway cancel iletimi):** `0ad37183` ile `stop_search` → AbortSignal → local AgentHub → WebSocket `cancel` → native Agent zinciri kuruldu. Gateway in-flight kotası, Agent yanıtı veya timeout gelene kadar korunuyor; sonuçlar stop sonrası geri dönmüyor. Actor/device izolasyonu korunuyor. Gateway negatif yarış testi eklendi.
- **D / PASSED (ara kod kontrolü):** `4071130f` rustfmt, `6f3eca4f` clippy ExecutionContext ve `523e532e` biçim düzeltmeleri. [CI #40085512074](https://github.com/orhanbal/webrising-commender/actions/runs/40085512074) kod HEAD'i için başlatıldı; son durum ayrıca kontrol edilmeli. İlk CI kırmızıları (fmt/clippy) düzeltildi.
- **Açık 1A:** Gerçek streaming ve pause/resume yok. Yerel relay için fiziksel iptal uygulanmış olsa da uçtan uca yavaş tarama sırasında durdurma testi ve bölgesel relay üzerinden iptal iletimi henüz doğrulanmadı; bu nedenle 1A **PENDING**.
- **Açık 1B:** PostgreSQL kalıcı arama oturumu ve restart sonrası actor/tenant/device izolasyonu **PENDING**. `stop_search` ile durdurulmuş snapshot hiçbir koşulda tekrar görünür olmamalı.
- **BLOCKED_EXTERNAL:** Gerçek Windows/macOS/Ubuntu fiziksel kurulum, canlı ChatGPT/Claude ve Windows/Apple imzalama/noter kanıtları yok. Eşdeğerlik **PENDING**.
- **Sonraki öncelik:** CI yeşilse 1A native streaming/pause, regional relay cancel ve 1B kalıcı search-session; kırmızıysa önce CI.

## 12.14 tetiklemesi — A/B/C/D P0 arama güvenliği ve sınırlandırma (2026-10-24)

- **A / PASSED (giriş):** `cf8387fa` için [ci #40080662828](https://github.com/orhanbal/webrising-commender/actions/runs/40080662828) 17/17 başarılı, [platform #40080948491](https://github.com/orhanbal/webrising-commender/actions/runs/40080948491) başarılı; Rust job logları incelendi. Girişte kırmızı CI yoktu.
- **B / PENDING (kodlandı):** `3db2cb23`, `e1fe01c5` — search-session kota semantiği: yalnız gerçek in-flight native taramalar slot tüketir, tamamlananlar tüketmez; durdurulan ama hâlâ çalışan native taramalar bitene kadar slotu tutar. Native hata mesajları redakte edilir; yarış/kota/redaksiyon testleri eklendi.
- **C / PENDING (kodlandı):** `cf41f58f`, `5c67b09b`, `93809aaa` — Rust dosya/içerik taramasında 10s monotonic süre bütçesi, `timedOut`/ `truncated` sinyali, MCP session özeti, Rust unit ve gerçek Linux Agent E2E kontrat testi. Tek bir filesystem syscall'ın 10s içinde kesileceği garanti edilmez; gerçek native cancel/streaming hâlâ PENDING.
- **D / PENDING:** [40 kalemlik kanonik kuyruk](HOURLY_BACKLOG_QUEUE_20261024.md) oluşturuldu; parity planı, MCP matrisi ve ana plan bağlantıları senkronize ediliyor. Yeni HEAD CI sonuçlanmadan `PASSED` ilan edilmez.
- **BLOCKED_EXTERNAL:** Gerçek Windows/macOS/Ubuntu, ChatGPT/Claude canlı kabulü ve imzalama/noter kanıtları.
- **Sonraki öncelik:** CI kırmızıysa düzelt; yeşilse 1A gerçek native streaming/cancel, 1B restart sonrası izole search-session persistence. Önceden tamamlanmış testleri yeniden yazma.

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


## 08.00 oturumu — son CI, MCP kontrat testi ve kabul envanteri (2026-10-24)

- **Giriş HEAD:** `5c9d860a`; GitHub Actions `ci #40060563045` **17/17 PASS**, `platform-distribution #40060992297` **PASS**.
- **Üç OS acceptance artifact mevcut:** `WECOMMANDER-windows-x64-acceptance`, `WECOMMANDER-linux-x64-acceptance`, `WECOMMANDER-macos-universal-acceptance`. Görsel test artifact'i `dashboard-visual-acceptance` da mevcut. Bu sonuç **fiziksel OS kurulumu ve imzalama değildir**.
- **Kodlandı:** `948ed6a3` — bilinmeyen MCP araçları cihaz/tenant DB sorgusundan önce açık `unknown_tool` döndürür; mevcut `device_id_required` semantiği geçerli araçlar için korunur.
- **Test eklendi:** `97413956` — gerçek HTTP MCP `tools/list` sözleşmesinde 46 araç adı tekilliği, JSON şema, zorunlu `device_id`, HIGH risk onay alanları ve `tools/call` bilinmeyen araç/eksik cihaz davranışı.
- **Envanter:** `5678e5fb` — `plans/MCP_TOOL_CONTRACT_MATRIX_20261024.md` içinde 46 MCP araç ve 35 doğrudan Agent E2E test çağrısı işaretlendi. Test varlığı tam platform kabulü değildir.
- **PENDING:** Bu yeni commit'lerin bulunduğu güncel HEAD'in CI/entegrasyon/dağıtım kabulü; en son koşu tamamlanmadan PASS olarak raporlanmaz.
- **AÇIK:** P0 gerçek streaming/cancel, kalıcı PTY spool/rollback; P1 PDF, DOCX düzenleme, görsel önizleme ve XLSM yazma; P2 fiziksel üç OS, ChatGPT/Claude, UI tüm işlev ve imzalama.
- **Karar:** Genel eşdeğerlik **TAMAMLANMADI**. Sonraki kod geliştirme önceliği PDF araçları ve P0 süreç/arama kalıcılığı; üretim/sunucuya dokunulmadı.

