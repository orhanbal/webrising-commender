# Launch email and in-app message — WECOMMANDER 1.0 (2026-11-23)

Drafts for the launch on **2026-11-23**. Nothing here is sent automatically:
paste the texts into the super admin console and send or publish them on the
day.

## How the console sends them

- **E-mail (Console → E-posta / Email campaigns):** a campaign has a
  **subject** (max. 150 characters) and a **plain-text** body (no Markdown, no
  HTML; links are written out). Only people who opted in to product news
  receive it, nobody gets the same campaign twice, and the system adds the
  bilingual unsubscribe footer and the one-click `List-Unsubscribe` header
  itself, so the texts below have no unsubscribe line.
- **There is no preheader field.** Mail apps show the first line of the body
  as the preview, so each body starts with its preheader line.
- **There is no language targeting** for e-mail or in-app messages. Two
  options: send the Turkish and the English campaign separately to the whole
  list (everyone gets both), or send **one bilingual mail** (Turkish body, a
  `—` line, the English body) with the bilingual subject below. The bilingual
  mail is recommended for the launch.
- **In-app messages (Console → Pazarlama / Marketing):** kind `announcement`
  (the card adds 📣 before the title, so the title has no emoji), title max.
  120 characters, body max. 600, button label max. 40, button link `https://`
  only. Each person sees it once.

Facts checked against `gateway/src/site-content.ts` and the 1.0 section of
`CHANGELOG.md`. Keep these limits when editing: Hybrid Access is Windows only;
the getting-started tutorial ships in the macOS app only (the Windows one is
not in 1.0); live monitoring is the Dock on Windows and the menu bar on macOS.

---

## E-mail

### Bilingual subject (recommended, one mail)

`WECOMMANDER 1.0 çıktı / 1.0 is here` (35 characters)

### Türkçe

**Konu:** `WECOMMANDER 1.0 yayında: SSH, sunucular ve yapay zekâ` (53 karakter)

**Önizleme (preheader, gövdenin ilk satırı):**
`Windows ve macOS için SSH istemcisi, sunucu yönetimi ve onayınla çalışan yapay zekâ.`

**Gövde:**

```text
Windows ve macOS için SSH istemcisi, sunucu yönetimi ve onayınla çalışan yapay zekâ.

Merhaba,

WECOMMANDER'a erkenden kaydoldun, haberi ilk sen al: 1.0 sürümü bugün Windows ve macOS için yayında.

Neler var:

• Tam bir SSH istemcisi: sekmeli ve bölünmüş terminaller, sürükle-bırak SFTP, tüneller ve jump host. Yapay zekâ ve hesap olmadan da çalışır.
• Sunucu yönetimi: diski neyin doldurduğunu gör; eski günlükleri, paket önbelleklerini ve Docker artıklarını güvenle temizle. Her değişiklik önce tam komutu gösterir.
• Windows'ta Dock: görev çubuğu gibi ekranın kenarında, sunucunun canlı grafikleriyle. macOS'ta canlı izleme menü çubuğunda.
• Kontrol sende olan yapay zekâ: Claude, ChatGPT ve Cursor tek MCP adresiyle makinelerine ulaşır. Komut, silme ve yeniden başlatma tek kullanımlık onayını bekler; her işlem denetim kaydında.
• Sunucuların, anahtarların ve parçacıkların uçtan uca şifreli eşitlenir.
• Türkçe dahil altı dil.

Windows'ta Hibrit Erişim ile ajan kurulu olmayan SSH sunucularını da yapay zekâyla kendi bilgisayarın üzerinden paylaşabilirsin; anahtarların bilgisayarından çıkmaz.

WECOMMANDER 1.0'ı indir: https://wecommander.app/download

Görüşlerini bu e-postayı yanıtlayarak bize yazabilirsin.

WECOMMANDER ekibi
```

### English

**Subject:** `WECOMMANDER 1.0 is here: SSH, servers and AI in one app` (55 characters)

**Preheader (first line of the body):**
`An SSH client, server management and AI that waits for your approval, for Windows and macOS.`

**Body:**

```text
An SSH client, server management and AI that waits for your approval, for Windows and macOS.

Hi,

You signed up early for WECOMMANDER, so you hear it first: version 1.0 is out today for Windows and macOS.

What you get:

• A complete SSH client: tabbed and split terminals, drag-and-drop SFTP, tunnels and jump hosts. It works without AI and without an account.
• Server management: see what fills a server's disk and safely clean old logs, package caches and Docker leftovers. Every change shows the exact command first.
• On Windows, the Dock: a taskbar-like bar on a screen edge with live charts for your server. On macOS, live monitoring sits in the menu bar.
• AI with you in charge: Claude, ChatGPT and Cursor reach your machines through one MCP address. Commands, deletions and restarts wait for your one-time approval, and every action is in the audit log.
• End-to-end encrypted sync of your servers, keys and snippets.
• Six languages, including English and Turkish.

On Windows, Hybrid Access also lets AI use SSH servers that have no agent, through your own computer; your keys never leave it.

Download WECOMMANDER 1.0: https://wecommander.app/download

Reply to this email to tell us what you think.

The WECOMMANDER team
```

Note: `/download` asks for sign-in first; everyone on this list has an
account, so that is fine here (the public posts link the home page instead).

---

## In-app message (Console → Pazarlama)

Kind `announcement`, start 2026-11-23, end 2026-12-07 (two weeks).

### Desktop apps (audience: Windows, macOS)

People who see it already have the app, so the button opens the notes.

| | Türkçe | English |
|---|---|---|
| Title | WECOMMANDER 1.0 yayında | WECOMMANDER 1.0 is here |
| Body | SSH istemcisi, sunucu yönetimi ve tek MCP adresiyle onayınla çalışan yapay zekâ artık 1.0. Sunucuların, anahtarların ve parçacıkların uçtan uca şifreli eşitlenir. | The SSH client, server management and AI that works through one MCP address with your approval are now 1.0. Your servers, keys and snippets sync with end-to-end encryption. |
| Button | Yenilikleri gör | See what's new |
| Link | https://wecommander.app/changelog | https://wecommander.app/changelog |

### Web dashboard (audience: Web)

| | Türkçe | English |
|---|---|---|
| Title | WECOMMANDER 1.0 masaüstü uygulaması yayında | The WECOMMANDER 1.0 desktop app is here |
| Body | Windows ve macOS için SSH istemcisi ve sunucu yönetimi; Windows'ta canlı grafikli Dock, macOS'ta menü çubuğunda canlı izleme. | An SSH client and server management for Windows and macOS, with the live-chart Dock on Windows and live monitoring in the macOS menu bar. |
| Button | Uygulamayı indir | Download the app |
| Link | https://wecommander.app/download | https://wecommander.app/download |

As with e-mail, messages cannot be targeted by language, and each campaign is
shown to everyone in its audience. Publish one language per audience, or one
bilingual card (title `WECOMMANDER 1.0 yayında / is here`, the Turkish body
then the English body; both together stay under 600 characters).
