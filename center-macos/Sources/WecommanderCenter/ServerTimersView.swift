import AppKit
import CenterCore
import SwiftUI

// "Zamanlayıcılar" in the server management window: systemd timers (disabled
// ones too, shown as "Pasif") with their next and last run, the service's
// user and command, its journal; enable, disable, run now, stop; WECOMMANDER's
// own timers can be created, edited and deleted. Cron is listed read only.
// Every change shows the exact command first (the Windows app's timers page).

private var timersDescription: String {
    L.t("Sunucudaki systemd zamanlayıcıları; devre dışı (pasif) olanlar da listelenir. Her değişiklikten önce sunucuda çalışacak komut gösterilir. Yalnız WECOMMANDER'ın oluşturduğu zamanlayıcılar düzenlenip silinebilir.")
}

/// Shown while the timers are read, or when they could not be.
struct TimersIntro: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.t("Zamanlayıcılar")).font(.largeTitle.weight(.semibold)).lineLimit(2)
            Text(timersDescription).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(L.t("Cron (salt okunur)")).font(.title2.weight(.semibold)).padding(.top, 8)
            Text(L.t("Cron görevleri yalnız gösterilir; buradan değiştirilmez.")).foregroundStyle(.secondary)
        }
    }
}

struct TimersPage: View {
    @ObservedObject var model: ServerManagementModel
    let s: ServerTimers

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(L.t("Zamanlayıcılar")).font(.largeTitle.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 12)
                Button(L.t("Yeni zamanlayıcı")) { model.editTimer(nil) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!(s.canChange && s.systemd))
            }
            Text(timersDescription).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !s.canChange {
                ServerNotice(title: L.t("Yalnız görüntüleme"),
                             text: L.t("Bu kullanıcı root değil ve parolasız sudo yok: zamanlayıcılar görünür ama etkinleştirme, çalıştırma ve düzenleme yapılamaz."),
                             kind: .info)
            }
            if s.systemd {
                TimerList(model: model, s: s)
            } else {
                ServerNotice(title: L.t("systemd bulunamadı"), text: L.t("Bu sunucuda systemctl yok; yalnız cron görevleri listelenir."), kind: .info)
            }
            CronSection(s: s)
        }
    }
}

private struct TimerList: View {
    @ObservedObject var model: ServerManagementModel
    let s: ServerTimers

    var body: some View {
        let shown: [ServerTimer] = TimerView.ordered(s.timers, filter: model.timerFilter)
        let system: [ServerTimer] = shown.filter { $0.isSystem }
        let user: [ServerTimer] = shown.filter { !$0.isSystem }
        let passive: Int = system.filter { TimerView.state($0) == "passive" }.count
        VStack(alignment: .leading, spacing: 10) {
            TextField(L.t("Ara (ad, açıklama, komut, kullanıcı)"), text: $model.timerFilter)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
            Text(L.f("Sistem zamanlayıcıları ({0})", system.count)).font(.title2.weight(.semibold)).padding(.top, 4)
            if passive > 0 {
                Text(L.f("{0} zamanlayıcı pasif: kendiliğinden çalışmaz.", passive)).foregroundStyle(.secondary)
            }
            ForEach(system) { t in TimerCard(model: model, t: t, canChange: s.canChange) }
            if !user.isEmpty {
                Text(L.f("{0} kullanıcısının zamanlayıcıları ({1})", s.loginUser, user.count))
                    .font(.title2.weight(.semibold)).padding(.top, 4)
                Text(L.t("systemctl --user ile çalışan zamanlayıcılar; burada yalnız gösterilir.")).foregroundStyle(.secondary)
                ForEach(user) { t in TimerCard(model: model, t: t, canChange: false) }
            }
            if shown.isEmpty {
                Text(L.t("Eşleşen zamanlayıcı yok.")).foregroundStyle(.secondary)
            }
        }
    }
}

private struct TimerBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(color))
    }
}

private struct TimerCard: View {
    @ObservedObject var model: ServerManagementModel
    let t: ServerTimer
    let canChange: Bool
    @State private var expanded = false

    private var stateColor: Color {
        switch TimerView.state(t) {
        case "active": return ServerColors.ok
        case "failed": return ServerColors.bad
        case "passive": return ServerColors.warn
        default: return .secondary
        }
    }

    private func when(_ unix: Int64?) -> String {
        let relative = TimerView.relative(unix, now: Date())
        let time = TimerView.time(unix)
        return relative.isEmpty ? time : time + " (" + relative + ")"
    }

    private var runLine: String {
        L.f("Sonraki çalışma: {0}  ·  Son çalışma: {1}  ·  Son sonuç: {2}", when(t.nextRun), when(t.lastRun), TimerView.result(t))
    }

    private var unitLine: String {
        let user = t.user.isEmpty ? "—" : t.user
        let state = t.unitFileState.isEmpty ? "—" : t.unitFileState
        return L.f("Kullanıcı: {0}  ·  Servis: {1}  ·  Birim dosyası: {2}", user, t.service, state)
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Text(t.unit).font(.body.monospaced().weight(.semibold)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    TimerBadge(text: TimerView.stateText(t), color: stateColor)
                    if t.isManaged { TimerBadge(text: "WECOMMANDER", color: .accentColor) }
                    Spacer(minLength: 0)
                }
                if !t.description.isEmpty {
                    Text(t.description).fixedSize(horizontal: false, vertical: true)
                }
                Text(L.f("Zamanlama: {0}", TimerView.schedule(t))).fixedSize(horizontal: false, vertical: true)
                Text(runLine).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(unitLine).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if !t.command.isEmpty {
                    Text(t.command).font(.caption.monospaced()).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                buttons
                if expanded {
                    TimerDetails(model: model, t: t)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button(L.t("Ayrıntılar ve günlük")) {
                expanded.toggle()
                if expanded && t.isSystem && model.timerLogs[t.unit] == nil { model.loadTimerLogs(t) }
            }
            if t.isSystem {
                if TimerView.canEnable(t) { action(L.t("Etkinleştir"), "enable", prominent: TimerView.state(t) == "passive") }
                if TimerView.canDisable(t) { action(L.t("Devre dışı bırak"), "disable", prominent: false) }
                if TimerView.canRunNow(t) { action(L.t("Şimdi çalıştır"), "start-now", prominent: false) }
                if TimerView.canStop(t) { action(L.t("Durdur"), "stop", prominent: false) }
                if t.isManaged {
                    Button(L.t("Düzenle")) { model.editTimer(t) }.disabled(!canChange)
                    Button(L.t("Sil")) { model.askDeleteTimer(t) }.disabled(!canChange)
                }
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func action(_ title: String, _ name: String, prominent: Bool) -> some View {
        let tip: String = canChange ? title : L.t("Bu işlem için sunucuda root ya da parolasız sudo gerekir.")
        if prominent {
            Button(title) { model.askTimerAction(t, name) }
                .buttonStyle(.borderedProminent).disabled(!canChange).help(tip)
        } else {
            Button(title) { model.askTimerAction(t, name) }
                .disabled(!canChange).help(tip)
        }
    }
}

/// Where a timer is defined, its service's state and its journal (loaded when opened).
private struct TimerDetails: View {
    @ObservedObject var model: ServerManagementModel
    let t: ServerTimer

    private var facts: String {
        let file = t.fragmentPath.isEmpty ? "—" : t.fragmentPath
        let persistent = t.persistent ? L.t("evet") : L.t("hayır")
        let state = t.serviceState.isEmpty ? "—" : t.serviceState
        return L.f("Dosya: {0}  ·  Kaçırılanı telafi et (Persistent): {1}  ·  Servis durumu: {2}  ·  Son bitiş: {3}",
                   file, persistent, state, TimerView.time(t.lastExit))
    }

    var body: some View {
        let logs = model.timerLogs[t.unit]
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            Text(facts).font(.caption.monospaced()).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if !t.serviceDescription.isEmpty && t.serviceDescription != t.description {
                Text(t.serviceDescription).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if t.isSystem {
                HStack(spacing: 8) {
                    Text(L.t("Günlük (son 200 satır)")).fontWeight(.semibold)
                    Button(L.t("Yenile")) { model.loadTimerLogs(t) }.disabled(logs?.loading == true)
                    if logs?.loading == true { ProgressView().controlSize(.small) }
                }
                if let note = logs?.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                ScrollView([.vertical, .horizontal]) {
                    Text(logs?.text ?? "")
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 80, maxHeight: 320)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
            }
        }
    }
}

/// Cron, read only: the login user's crontab, /etc/crontab, /etc/cron.d and the cron.daily-style folders.
private struct CronSection: View {
    let s: ServerTimers

    var body: some View {
        let note = TimerView.crontabNote(s)
        let extra: String = s.crontabMessage.isEmpty ? "" : "  ·  " + s.crontabMessage
        VStack(alignment: .leading, spacing: 8) {
            Text(L.t("Cron (salt okunur)")).font(.title2.weight(.semibold)).padding(.top, 8)
            Text(L.t("Cron görevleri yalnız gösterilir; buradan değiştirilmez.")).foregroundStyle(.secondary)
            if !note.isEmpty {
                Text(note + extra).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 0) {
                    CronRow(e: nil)
                    Divider()
                    ForEach(Array(s.cron.enumerated()), id: \.offset) { item in CronRow(e: item.element) }
                    if s.cron.isEmpty {
                        Text(L.t("Cron görevi bulunamadı.")).foregroundStyle(.secondary).padding(6)
                    }
                }
            }
        }
    }
}

private struct CronRow: View {
    let e: CronEntry?

    private var cells: [String] {
        guard let e else { return [L.t("Zaman"), L.t("Kullanıcı"), L.t("Komut"), L.t("Kaynak")] }
        if e.unreadable { return ["—", "—", L.t("okunamadı (izin yok)"), e.source] }
        return [e.schedule, e.user, e.command, e.source]
    }

    var body: some View {
        let c = cells
        let header = e == nil
        HStack(spacing: 12) {
            cell(c[0], header: header, mono: true).frame(width: 130, alignment: .leading)
            cell(c[1], header: header, mono: false).frame(width: 100, alignment: .leading)
            cell(c[2], header: header, mono: true).frame(maxWidth: .infinity, alignment: .leading).help(header ? "" : c[2])
            cell(c[3], header: header, mono: true).foregroundStyle(.secondary).frame(width: 190, alignment: .leading)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
    }

    @ViewBuilder
    private func cell(_ text: String, header: Bool, mono: Bool) -> some View {
        if header {
            Text(text).fontWeight(.semibold).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        } else {
            Text(text).font(mono ? .caption.monospaced() : .body).lineLimit(1).truncationMode(.tail).textSelection(.enabled)
        }
    }
}

/// Create or edit a WECOMMANDER timer: the form; the commands are confirmed next.
struct TimerFormSheet: View {
    let request: ServerManagementModel.TimerFormRequest
    let onNext: (TimerSpec) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var about: String
    @State private var command: String
    @State private var user: String
    @State private var calendar: String

    init(request: ServerManagementModel.TimerFormRequest, onNext: @escaping (TimerSpec) -> Void) {
        self.request = request
        self.onNext = onNext
        _name = State(initialValue: request.spec.name)
        _about = State(initialValue: request.spec.description)
        _command = State(initialValue: request.spec.command)
        _user = State(initialValue: request.spec.user)
        _calendar = State(initialValue: request.spec.calendar)
    }

    var body: some View {
        let title: String = request.edit ? L.f("{0} düzenle", request.spec.name + ".timer") : L.t("Yeni zamanlayıcı")
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.title2.weight(.semibold)).lineLimit(2)
            if let error = request.error {
                ServerNotice(title: nil, text: error, kind: .error)
            }
            Form {
                Section {
                    TextField(L.t("Ad (birim dosyalarının adı)"), text: $name, prompt: Text("nightly-backup"))
                        .font(.body.monospaced())
                        .disabled(request.edit)
                    TextField(L.t("Açıklama"), text: $about)
                }
                Section {
                    TextField(L.t("Komut"), text: $command, prompt: Text("/usr/local/bin/backup.sh --full"))
                        .font(.body.monospaced())
                    Text(L.t("Komut /bin/sh -c ile çalışır; | ve && kullanılabilir.")).font(.caption).foregroundStyle(.secondary)
                    TextField(L.t("Çalıştıran kullanıcı"), text: $user, prompt: Text("root"))
                        .font(.body.monospaced())
                    TextField(L.t("Takvim (OnCalendar)"), text: $calendar, prompt: Text("daily"))
                        .font(.body.monospaced())
                    Text(L.t("Örnekler: hourly, daily, weekly, Mon..Fri *-*-* 03:00, *-*-* 04:30:00, *:0/15 (15 dakikada bir)."))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button(L.t("Vazgeç")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L.t("Devam")) {
                    let spec = TimerSpec(name: request.edit ? request.spec.name : name, description: about,
                                         command: command, user: user, calendar: calendar)
                    dismiss()
                    onNext(spec)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 560, height: 520)
    }
}
