import Foundation
import XCTest
@testable import CenterCore

/// Server management: the core's server.* JSON, the cleanup page's sections
/// per Docker daemon, the space freed after a cleanup, and sizes as people
/// say them (the same cases as the Windows app's ServerManagementTests and
/// CleanupLayoutTests).
final class ServerManagementTests: XCTestCase {
    override func setUp() { L.use("tr") }
    override func tearDown() { L.use("tr") }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // What `server.cleanupScan` returns for the system daemon, DEVAGENT's rootless one and one it could not read.
    private let scanJSON = """
    {"items":[
      {"id":"journal","title":"Sistem günlükleri","detail":"","kb":1000,"command":"journalctl --vacuum-time=7d","warning":"","docker":"","group":""},
      {"id":"docker-build","title":"Docker build önbelleği","detail":"","kb":0,"command":"docker -H unix:///var/run/docker.sock builder prune -af","warning":"","docker":"system","group":""},
      {"id":"docker-build@u1000","title":"DEVAGENT-CI — Rootless Docker — build önbelleği","detail":"","kb":32978515,"command":"docker -H unix:///run/user/1000/docker.sock builder prune -af","warning":"","docker":"u1000","group":""},
      {"id":"docker-dangling@u1000","title":"DEVAGENT-CI — Rootless Docker — etiketsiz imajlar","detail":"","kb":1953125,"command":"docker -H unix:///run/user/1000/docker.sock image prune -f","warning":"","docker":"u1000","group":"images@u1000"},
      {"id":"docker-unused@u1000","title":"DEVAGENT-CI — Rootless Docker — kullanılmayan tüm imajlar","detail":"","kb":13574218,"command":"docker -H unix:///run/user/1000/docker.sock image prune -af","warning":"Coolify…","docker":"u1000","group":"images@u1000"}
    ],
    "privilege":"root",
    "disk":null,
    "dockers":[
      {"id":"system","kind":"system","label":"Sistem Docker","user":"root","uid":0,"socket":"/var/run/docker.sock","rootDir":"/var/lib/docker","imagesBytes":2500000000,"imagesReclaimableBytes":0,"buildCacheBytes":0,"buildCacheReclaimableBytes":0,"containersBytes":0,"volumesBytes":0,"danglingBytes":0,"imagesTotal":2,"imagesActive":2,"containersTotal":2,"containersRunning":2,"running":["coolify (coolify:4)"],"error":""},
      {"id":"u1000","kind":"rootless","label":"DEVAGENT-CI — Rootless Docker","user":"devagent-ci","uid":1000,"socket":"/run/user/1000/docker.sock","rootDir":"/var/lib/devagent-ci/.local/share/docker","imagesBytes":15000000000,"imagesReclaimableBytes":13900000000,"buildCacheBytes":33770000000,"buildCacheReclaimableBytes":33770000000,"containersBytes":2000000,"volumesBytes":328000000,"danglingBytes":2000000000,"imagesTotal":31,"imagesActive":1,"containersTotal":2,"containersRunning":1,"running":["devagent-stage2-gpu-relay (devagent/relay:42)"],"error":""},
      {"id":"u1001","kind":"rootless","label":"CI2 — Rootless Docker","user":"ci2","uid":1001,"socket":"/run/user/1001/docker.sock","rootDir":"","imagesBytes":0,"imagesReclaimableBytes":0,"buildCacheBytes":0,"buildCacheReclaimableBytes":0,"containersBytes":0,"volumesBytes":0,"danglingBytes":0,"imagesTotal":0,"imagesActive":0,"containersTotal":0,"containersRunning":0,"running":[],"error":"Bu Docker'a erişim izni yok."}
    ]}
    """

    func testEachDockerDaemonIsItsOwnSectionWithItsOwnItems() throws {
        let scan = try decode(CleanupScan.self, scanJSON)
        let sections = CleanupLayout.sections(scan)
        XCTAssertEqual(sections.count, 4)
        XCTAssertNil(sections[0].docker)
        XCTAssertEqual(sections[0].items.map(\.id), ["journal"])
        XCTAssertEqual(sections[1].docker?.id, "system")
        XCTAssertEqual(sections[1].items.map(\.id), ["docker-build"])

        let devagent = sections[2]
        let env = try XCTUnwrap(devagent.docker)
        XCTAssertEqual(env.label, "DEVAGENT-CI — Rootless Docker")
        XCTAssertTrue(env.rootless)
        XCTAssertEqual(env.socket, "/run/user/1000/docker.sock")
        XCTAssertEqual(env.buildCacheBytes, 33_770_000_000)
        XCTAssertEqual(env.reclaimableBytes, 33_770_000_000 + 13_900_000_000)
        XCTAssertEqual(env.running, ["devagent-stage2-gpu-relay (devagent/relay:42)"])
        XCTAssertEqual(devagent.items.map(\.id), ["docker-build@u1000", "docker-dangling@u1000", "docker-unused@u1000"])
        // Every DEVAGENT command goes to DEVAGENT's daemon, never the system one.
        for item in devagent.items { XCTAssertTrue(item.command.contains("/run/user/1000/docker.sock")) }
        // Untagged and unused images overlap: one group, never both added up.
        XCTAssertEqual(devagent.items[1].group, devagent.items[2].group)

        // A daemon that could not be read: shown, with its reason, and nothing to clean.
        XCTAssertEqual(sections[3].docker?.id, "u1001")
        XCTAssertFalse(sections[3].docker?.error.isEmpty ?? true)
        XCTAssertTrue(sections[3].items.isEmpty)
    }

    func testAnOlderCoreWithoutDaemonsStillListsItsItems() throws {
        let scan = try decode(CleanupScan.self, #"{"items":[{"id":"docker-build","title":"t","detail":"","kb":5,"command":"docker builder prune -af","warning":""}],"privilege":"root"}"#)
        let sections = CleanupLayout.sections(scan)
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].items.first?.id, "docker-build")
    }

    func testOnlyOneOfAGroupIsChosenAndNothingWithoutRights() throws {
        let scan = try decode(CleanupScan.self, scanJSON)
        // Ticked at first: sizes without a warning; the empty build cache and the warned item are not.
        XCTAssertEqual(scan.defaultChoice(), ["journal", "docker-build@u1000", "docker-dangling@u1000"])
        // Ticking "all unused images" unticks the untagged ones (part of them), and back.
        var chosen = scan.choose("docker-unused@u1000", true, in: scan.defaultChoice())
        XCTAssertTrue(chosen.contains("docker-unused@u1000"))
        XCTAssertFalse(chosen.contains("docker-dangling@u1000"))
        chosen = scan.choose("docker-dangling@u1000", true, in: chosen)
        XCTAssertFalse(chosen.contains("docker-unused@u1000"))
        // Nothing to free: never chosen.
        XCTAssertFalse(scan.choose("docker-build", true, in: []).contains("docker-build"))

        // Not root or sudo: the server's own items are off; Docker ones go through the daemon.
        let viewer = CleanupScan(items: scan.items, privilege: "", disk: nil, dockers: scan.dockers)
        XCTAssertFalse(viewer.canChange)
        XCTAssertFalse(viewer.allowed(scan.items[0]))
        XCTAssertFalse(viewer.defaultChoice().contains("journal"))
        XCTAssertFalse(viewer.choose("journal", true, in: []).contains("journal"))
        XCTAssertTrue(viewer.allowed(scan.items[2]))
    }

    func testDiskFoldersAreMatchedToTheirDockerDaemon() {
        let stores = [
            DockerStore(id: "system", kind: "system", label: "Sistem Docker", user: "root", socket: "/var/run/docker.sock", rootDir: "/var/lib/docker", error: ""),
            DockerStore(id: "u1000", kind: "rootless", label: "DEVAGENT-CI — Rootless Docker", user: "devagent-ci", socket: "/run/user/1000/docker.sock",
                        rootDir: "/var/lib/devagent-ci/.local/share/docker", error: ""),
        ]
        XCTAssertEqual(CleanupLayout.storeFor("/var/lib/devagent-ci", stores)?.id, "u1000")
        XCTAssertEqual(CleanupLayout.storeFor("/var/lib/devagent-ci/.local/share/docker/containerd", stores)?.id, "u1000")
        XCTAssertEqual(CleanupLayout.storeFor("/var/lib/docker", stores)?.id, "system")
        XCTAssertNil(CleanupLayout.storeFor("/var/lib/containerd", stores))
        XCTAssertNil(CleanupLayout.storeFor("/var/lib/dock", stores))
        XCTAssertNil(CleanupLayout.storeFor("/x", nil))
        // Only at or inside the storage, not a folder that holds it.
        XCTAssertNil(CleanupLayout.storeInside("/var/lib/devagent-ci", stores))
        XCTAssertEqual(CleanupLayout.storeInside("/var/lib/docker/overlay2", stores)?.id, "system")
    }

    func testTheSpaceFreedIsMeasuredAndTheGapExplained() {
        XCTAssertEqual(CleanupLayout.freed(1000, nil, 5000), "")
        let close = CleanupLayout.freed(1_000_000, 10_000_000, 10_950_000)
        XCTAssertTrue(close.hasPrefix("Diskte gerçekten"))
        XCTAssertFalse(close.contains("Fark normaldir"))
        let far = CleanupLayout.freed(33_000_000, 10_000_000, 30_000_000)
        XCTAssertTrue(far.contains("Fark normaldir"))
        // Less free space afterwards (files written meanwhile): nothing freed, never a crash.
        XCTAssertTrue(CleanupLayout.freed(1000, 5000, 4000).hasPrefix("Diskte gerçekten 0 B"))
    }

    func testTheCoresServerJsonIsRead() throws {
        let o = try decode(ServerOverview.self, """
            {"hostname":"web1","os":"Ubuntu 24.04","kernel":"Linux 6.8","uptimeSecs":3672000,"load":[0.81,0.68,0.75],"cpus":8,"cpuPercent":12.5,
             "memTotalKb":16000000,"memAvailableKb":9700000,"swapTotalKb":3200000,"swapFreeKb":1000000,
             "disks":[{"device":"/dev/sda2","fsType":"ext4","mount":"/","sizeKb":144000000,"usedKb":124000000,"availKb":14000000}],
             "rebootRequired":true,"updates":"31 updates can be applied immediately.","processes":819,"zombies":173,"privilege":"root","docker":true}
            """)
        XCTAssertTrue(o.canChange)
        XCTAssertEqual(o.zombies, 173)
        XCTAssertEqual(o.disks[0].usedPercent, 89.9)
        XCTAssertEqual(o.rootDisk?.mount, "/")
        XCTAssertEqual(o.memUsedKb, 6_300_000)
        let p = try decode(ProcessList.self, """
            {"processes":[{"pid":2849530,"ppid":1,"user":"1000","state":"Sl","cpu":3.2,"mem":4.0,"rssKb":650000,"elapsedSecs":86400,"name":"next-server (v","command":"next-server (v15)"}],
             "zombies":[{"parent":{"pid":2849530,"ppid":1,"user":"1000","state":"Sl","cpu":3.2,"mem":4.0,"rssKb":650000,"elapsedSecs":86400,"name":"next-server (v","command":"next-server (v15)"},
                         "count":172,"owner":{"kind":"container","id":"abc123abc123","name":"web"},"protected":""}],"privilege":"sudo"}
            """)
        XCTAssertTrue(p.canChange)
        XCTAssertEqual(p.zombies[0].count, 172)
        XCTAssertEqual(p.zombies[0].owner.kind, "container")
        XCTAssertTrue(p.zombies[0].canRestartOwner)
        XCTAssertEqual(p.zombies[0].restartCommand, "docker restart abc123abc123")
        XCTAssertEqual(p.zombies[0].parent.signalCommand("reap"), "kill -CHLD 2849530")
        let c = try decode(CleanupScan.self, #"{"items":[{"id":"apt-cache","title":"t","detail":"d","kb":2048,"command":"apt-get clean","warning":""}],"privilege":""}"#)
        XCTAssertEqual(c.items[0].kb, 2048)
        XCTAssertFalse(c.canChange)
        let sm = try decode(ServerSample.self, #"{"uptime":100.5,"cpuTotal":1000,"cpuIdle":800,"memTotalKb":1000,"memAvailableKb":400,"swapTotalKb":0,"swapFreeKb":0,"load1":0.5,"netRxBytes":1,"netTxBytes":2,"diskReadBytes":3,"diskWriteBytes":4}"#)
        XCTAssertEqual(sm.diskWriteBytes, 4)
        XCTAssertEqual(sm.zombies, 0)
        XCTAssertEqual(sm.memPercent, 60)
        let fix = try decode(InitFix.self, #"{"status":"applied","app":"web","message":""}"#)
        XCTAssertEqual(fix.status, "applied")
        let u = try decode(DiskUsage.self, #"{"path":"/var","totalKb":10,"entries":[{"path":"/var/lib","kb":8}],"docker":[],"complete":false}"#)
        XCTAssertNil(u.dockerStores)
        XCTAssertFalse(u.complete)
    }

    func testRatesComeFromTwoSamples() {
        let a = ServerSample(uptime: 100, cpuTotal: 1000, cpuIdle: 800, memTotalKb: 1000, memAvailableKb: 500, swapTotalKb: 0, swapFreeKb: 0,
                             load1: 0.1, netRxBytes: 1000, netTxBytes: 0, diskReadBytes: 0, diskWriteBytes: 0)
        let b = ServerSample(uptime: 102, cpuTotal: 1200, cpuIdle: 900, memTotalKb: 1000, memAvailableKb: 500, swapTotalKb: 0, swapFreeKb: 0,
                             load1: 0.2, netRxBytes: 5000, netTxBytes: 2000, diskReadBytes: 0, diskWriteBytes: 4096)
        let r = ServerRates.between(a, b)
        XCTAssertEqual(r?.cpuPercent, 50)
        XCTAssertEqual(r?.netRx, 2000)
        XCTAssertEqual(r?.netTx, 1000)
        XCTAssertEqual(r?.diskWrite, 2048)
        // The server restarted (counters went back): no rate, never a crash.
        XCTAssertNil(ServerRates.between(b, a))
    }

    func testTheProcessTableFiltersAndSorts() {
        let list = ProcessList(processes: [
            ServerProcess(pid: 10, user: "root", cpu: 1, rssKb: 900, name: "postgres", command: "postgres -D /data"),
            ServerProcess(pid: 20, user: "www", cpu: 30, rssKb: 100, name: "node", command: "node server.js"),
            ServerProcess(pid: 30, user: "www", state: "Z", cpu: 0, rssKb: 0, name: "sh", command: "[sh] <defunct>"),
        ], zombies: [], privilege: "")
        XCTAssertFalse(list.canChange)
        XCTAssertEqual(list.shown(filter: "", byMemory: false).map(\.pid), [20, 10])
        XCTAssertEqual(list.shown(filter: "", byMemory: true).map(\.pid), [10, 20])
        XCTAssertEqual(list.shown(filter: "WWW", byMemory: false).map(\.pid), [20])
        XCTAssertEqual(list.shown(filter: "10", byMemory: false).map(\.pid), [10])
        XCTAssertEqual(list.shown(filter: "defunct", byMemory: false).map(\.pid), [])
        XCTAssertEqual(list.processes[1].signalCommand("term"), "kill -TERM 20")
        XCTAssertEqual(list.processes[1].signalCommand("kill"), "kill -KILL 20")
    }

    func testDiskPaths() {
        XCTAssertEqual(DiskPaths.parent("/var/lib/docker"), "/var/lib")
        XCTAssertEqual(DiskPaths.parent("/var/"), "/")
        XCTAssertEqual(DiskPaths.parent("/"), "/")
        XCTAssertEqual(DiskPaths.name("/var/lib", "/var/lib/docker"), "docker")
        XCTAssertEqual(DiskPaths.name("/", "/var"), "var")
    }

    func testSizesReadLikePeopleSayThem() {
        XCTAssertEqual(Sizes.kb(118 * 1024 * 1024), "118 GB")
        XCTAssertEqual(Sizes.kb(1536).replacingOccurrences(of: ",", with: "."), "1.5 MB")
        XCTAssertEqual(Sizes.bytes(512), "512 B")
        XCTAssertEqual(Sizes.duration(42 * 86400 + 12 * 3600 + 5), "42 gün 12 sa")
        XCTAssertEqual(Sizes.duration(3 * 3600 + 5 * 60), "3 sa 5 dk")
        XCTAssertEqual(Sizes.duration(40), "40 sn")
        XCTAssertEqual(Sizes.percent(39.4), "%39")
        XCTAssertEqual(Sizes.rate(-5), "0 B/sn")
        XCTAssertEqual(Sizes.kb(UInt64.max).hasSuffix("TB"), true)
        L.use("en")
        XCTAssertEqual(Sizes.percent(39.6), "40%")
        XCTAssertEqual(Sizes.kb(1536), "1.5 MB")
        XCTAssertEqual(Sizes.duration(40), "40 s")
    }
}
