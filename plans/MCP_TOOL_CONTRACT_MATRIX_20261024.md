## 12.14 P0 arama sözleşmesi güncellemesi — CI bekliyor

- `fs_search` ve `text_search` native Agent çıktısı artık `timedOut: boolean` taşır; `truncated` süre bütçesi aşıldığında `true` olur. 10s süre bütçesi dosya/dizin/satır döngüsünde denetlenir; tek filesystem syscall'ın zorla durdurulması değildir.
- `start_search` → `get_more_search_results` sayfalı snapshot'ında `timedOut` raporlanır. MCP araç adı/şema sayısı **46 olarak değişmedi**.
- In-flight concurrency slotu, `stop_search` sonrasında native istek sonuçlanıncaya kadar tutulur; tamamlanan oturumlar kota tüketmez. Hata mesajları allowlist dışındaysa `search_failed` döner.
- Kod/test commitleri: `3db2cb23`, `e1fe01c5`, `cf41f58f`, `5c67b09b`, `93809aaa`. Güncel HEAD'in CI ve gerçek Agent E2E sonucu **PENDING**.
- Bu değişiklik **native streaming/pause/physical cancel veya restart persistence** değildir; 1A/1B açık kalır. Bütün 46 aracın kabul durumu [40 alt görevlik kuyrukta](HOURLY_BACKLOG_QUEUE_20261024.md) izlenir.

# WECOMMANDER — MCP araç sözleşmesi ve kabul matrisi

Güncelleme: 24 Ekim 2026. Kaynak: `gateway/src/mcp.ts`, `gateway/src/protocol.ts`, `gateway/test/agent-e2e.mjs`. **Bu dosya koddan çıkarılan mevcut araç kaydını gösterir; rakip ürünle tam eşdeğerlik veya fiziksel cihaz kabulü kanıtı değildir.**

## Kanıt ve kabul ölçütleri

- **PASS (başlangıç):** `5c9d860a`, GitHub Actions CI `40060563045` 17/17 başarılı; dağıtım `40060992297` başarılı. Bu sürümdeki kayıtlı araçlar derleniyor ve genel CI geçiyor.
- **PENDING (yeni test):** `gateway/test/integration.mjs` içinde araç adı tekilliği, JSON şema/required alanları, cihaz kapsamı, HIGH onay alanı ve bilinmeyen araç davranışı için yeni sözleşme regresyon testi eklendi. Bu testin bulunduğu yeni HEAD CI geçmeden PASS denmez.
- **E2E çağrısı mevcut:** Kaynak dosyasında doğrudan `tool(id, name, args)` çağrısı tespit edildi. Bu işaret **yalnız test varlığını** gösterir; tüm parametre/OS/izin varyantlarının geçtiğini göstermez.
- **Risk:** `gateway/src/protocol.ts` `actionRisk` sınıflandırması. Gateway-only işlemler LOW ve kimlik/rol sınırlarına tabidir.
- **OS kabulü:** Windows/macOS derleme ve installer artifact CI'sı gerçek cihaz üzerinde kurulum, yükseltme, kaldırma ve canlı istemci testi yerine geçmez.

## Kayıtlı araçlar (46)

| MCP araç adı | Kategori | Risk | Yürütme | Linux Agent E2E testi |
|---|---|---|---|---|
| `devices_list` | Sistem | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `system_info` | Sistem | LOW | Agent | E2E çağrısı mevcut |
| `policy_info` | Sistem | LOW | Agent | E2E çağrısı mevcut |
| `get_recent_tool_calls` | Audit | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `get_usage_stats` | Audit | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_list` | Dosya | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_stat` | Dosya | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_read` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `fs_read_lines` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `image_inspect` | Görsel | LOW | Agent | E2E çağrısı mevcut |
| `docx_inspect` | Word | LOW | Agent | E2E çağrısı mevcut |
| `docx_read_paragraphs` | Word | LOW | Agent | E2E çağrısı mevcut |
| `docx_read_table` | Word | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_inspect` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_read_range` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_find` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_write_cells` | Excel | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_read_multiple` | Dosya | LOW | Gateway | E2E çağrısı mevcut |
| `fs_write` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_append` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_mkdir` | Dosya | MEDIUM | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_delete` | Dosya | HIGH | Agent | E2E çağrısı mevcut |
| `fs_move` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_tree` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `fs_search` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `text_search` | Arama | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `code_search` | Arama | LOW | Agent (text_search alias) | E2E çağrısı mevcut |
| `start_search` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `get_more_search_results` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `list_searches` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `stop_search` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `fs_replace` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `process_exec` | Süreç | HIGH | Agent | E2E çağrısı mevcut |
| `process_list` | Süreç | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `process_kill` | Süreç | HIGH | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `task_start` | Görev | HIGH | Agent | E2E çağrısı mevcut |
| `task_status` | Görev | LOW | Agent | E2E çağrısı mevcut |
| `task_cancel` | Görev | HIGH | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `task_list` | Görev | LOW | Agent | E2E çağrısı mevcut |
| `terminal_start` | Terminal | HIGH | Agent | E2E çağrısı mevcut |
| `terminal_input` | Terminal | MEDIUM | Agent | E2E çağrısı mevcut |
| `terminal_read` | Terminal | LOW | Agent | E2E çağrısı mevcut |
| `terminal_read_page` | Terminal | LOW | Agent | E2E çağrısı mevcut |
| `terminal_resize` | Terminal | MEDIUM | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `terminal_stop` | Terminal | HIGH | Agent | E2E çağrısı mevcut |
| `terminal_list` | Terminal | LOW | Agent | E2E çağrısı mevcut |

## Açık kabul boşlukları

1. **P0:** Native arama akışını gerçekten iptal/askıya alma; Gateway yeniden başlatma sonrası arama durumu; PTY kalıcı tam çıktı spool'u, REPL algılama, süreç ağacı temizleme, sürüm/rollback.
2. **P1:** PDF okuma/birleştirme/düzenleme araçları henüz kayıtlı değil; DOCX düzenleme ve biçim koruma, gerçek görsel önizleme ve XLSM güvenli yazma yok. XLSX karmaşık OOXML roundtrip kabulü açık.
3. **P2:** Gerçek ChatGPT/Claude MCP bağlantısı, fiziksel Windows/macOS/Ubuntu kurulum/upgrade/uninstall, platform imzalama ve kullanıcı paneli bütün işlev kabulü açık.
4. **Güvenlik:** Her araca ait izin, sınır, hatalı argüman, dosya sistemi yarış koşulu, quota, audit ve platform test matrisi ayrıca kapatılmalı. Bu statik kayıt tablosu yeterli değildir.

**Kapanış kuralı:** `main` CI PASS + gerçek Agent↔Gateway E2E + platform ve canlı MCP istemci kabulü kanıtları olmadan “Desktop Commander parity achieved” yazılamaz.
