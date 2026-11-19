import assert from "node:assert/strict";
import test from "node:test";
import { safetyNetCheck } from "./safety-net.js";

const blocked = (cmd: string, rule?: string, options = {}) => {
  const hit = safetyNetCheck(cmd, options);
  assert.ok(hit, `should be blocked: ${JSON.stringify(cmd)}`);
  if (rule) assert.equal(hit!.rule, rule, JSON.stringify(cmd));
};
const passes = (cmd: string, options = {}) =>
  assert.equal(safetyNetCheck(cmd, options), null, `should pass: ${JSON.stringify(cmd)}`);

test("recursive deletes of / and its variants are blocked", () => {
  for (const cmd of [
    "rm -rf /", "rm -rf /*", "rm -fr /", "rm -Rf /", "rm -r -f /", "rm --recursive --force /",
    "rm -rf //", "rm -rf /.", "rm -rf /./", "rm -rf /tmp/../", "rm -rf '/'", "rm -rf \"/\"", "rm -rf -- /",
    "sudo rm -rf /", "sudo -n rm -rf /*", "sudo -u root rm -rf /", "/bin/rm -rf /", "env X=1 rm -rf /",
    "nohup rm -rf / &", "timeout 10 rm -rf /", "cd /tmp && rm -rf /", "true; rm -rf /*", "ls | rm -rf /",
    "bash -c 'rm -rf /'", "sh -c \"sudo rm -rf /*\"", "sudo bash -lc 'rm -rf /'", "eval rm -rf /",
    "echo $(rm -rf /)", "echo \"$(rm -rf /)\"", "echo `rm -rf /`", "rm -rf /etc", "rm -rf /usr/*",
    "rm -rf /var/", "rm -rf /home", "rm -rf ~", "rm -rf ~/", "rm -rf $HOME", "rm -rf ${HOME}/",
    "rm -rf /boot /tmp/x", "rm --no-preserve-root -rf /", "rm -r --no-preserve-root /mnt/x",
  ]) blocked(cmd, "rm_root");
});

test("ordinary deletes pass", () => {
  for (const cmd of [
    "rm -rf ./build", "rm -rf build", "rm -rf node_modules dist", "rm -rf /tmp/build-123", "rm -rf /var/www/old",
    "rm -rf /home/deploy/app/cache", "rm -rf ~/projects/tmp", "rm /etc/nginx/sites-enabled/default",
    "rm -f /var/log/app.log", "rm -rf /tmp/*", "rm -rf /opt/myapp/releases/1", "rm -rf .", "rm -rf ../old",
    "echo 'rm -rf /'", "git commit -m \"rm -rf / is bad\"", "grep -r 'rm -rf /' docs", "ls /",
    "find /var/log -name '*.gz' -delete", "rm -i /etc/hosts.bak",
  ]) passes(cmd);
});

test("formatting and overwriting disks is blocked", () => {
  for (const [cmd, rule] of [
    ["mkfs.ext4 /dev/sdb1", "disk_format"], ["mkfs -t xfs /dev/nvme0n1p2", "disk_format"],
    ["sudo wipefs -a /dev/sda", "disk_format"], ["mke2fs /dev/vdb", "disk_format"], ["mkswap /dev/sdc", "disk_format"],
    ["blkdiscard /dev/nvme0n1", "disk_format"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "disk_overwrite"], ["dd if=x.img of=/dev/nvme0n1", "disk_overwrite"],
    ["sudo dd if=/dev/urandom of=/dev/vda", "disk_overwrite"], ["dd of=/dev/xvda if=/dev/zero", "disk_overwrite"],
    ["cat image.iso > /dev/sdb", "disk_overwrite"], ["echo x >/dev/mmcblk0", "disk_overwrite"],
    ["shred -n 1 /dev/sda", "disk_overwrite"],
  ] as const) blocked(cmd, rule);
});

test("ordinary disk and dd use passes", () => {
  for (const cmd of [
    "dd if=/dev/zero of=disk.img bs=1M count=10", "dd if=/dev/sda of=/backup/mbr.bin bs=512 count=1",
    "dd if=/dev/zero of=/dev/null", "dd if=x of=/dev/sda1", "mkfs.ext4 ./disk.img", "lsblk", "df -h", "wipefs --help",
    "cmd 2>/dev/null", "echo hi > /tmp/out.txt", "cat /dev/sda > /dev/null", "fdisk -l /dev/sda",
  ]) passes(cmd);
});

test("fork bombs are blocked", () => {
  for (const cmd of [":(){ :|:& };:", ":(){ :|: & };:", "bomb(){ bomb|bomb& }; bomb", "bash -c ':(){ :|:& };:'"]) {
    blocked(cmd, "fork_bomb");
  }
  passes("f(){ echo hi; }; f");
});

test("power commands are blocked unless allowed", () => {
  for (const cmd of ["reboot", "sudo reboot", "shutdown -h now", "shutdown -r +5", "poweroff", "halt",
    "systemctl reboot", "sudo systemctl poweroff", "systemctl --force reboot", "init 0", "telinit 6",
    "/sbin/shutdown now", "apt-get upgrade -y && reboot"]) {
    blocked(cmd, "power");
    passes(cmd, { allowPower: true });
  }
  for (const cmd of ["shutdown -c", "systemctl status nginx", "systemctl restart nginx", "echo reboot", "last reboot",
    "journalctl --list-boots", "init --version", "systemctl list-units"]) passes(cmd);
});

test("removing the agent's own service is blocked", () => {
  for (const cmd of ["systemctl stop webrising-commender", "sudo systemctl disable webrising-commender.service",
    "systemctl mask webrising-commender", "systemctl disable --now webrising-commender", "service webrising-commender stop",
    "rm /etc/systemd/system/webrising-commender.service", "sudo rm -f /usr/local/bin/webrising-commender",
    "pkill webrising-commender", "killall -9 webrising-commender", "rm /etc/sudoers.d/wecommander-agent"]) {
    blocked(cmd, "agent_service");
  }
  for (const cmd of ["systemctl status webrising-commender", "systemctl restart webrising-commender",
    "journalctl -u webrising-commender -n 50", "systemctl stop nginx"]) passes(cmd);
});

test("recursive permission changes on / are blocked, others pass", () => {
  blocked("chmod -R 777 /", "chmod_root");
  blocked("sudo chown -R nobody /", "chmod_root");
  passes("chmod -R 755 /var/www/app");
  passes("chown -R www-data:www-data /srv/site");
  passes("chmod 644 /etc/hosts");
});

test("empty or odd input never throws", () => {
  for (const cmd of ["", "   ", "'", "\"", "$(", "`", "rm", "rm -rf", "sudo", "sh -c", "{", "}", "((", "\\"]) {
    assert.doesNotThrow(() => safetyNetCheck(cmd));
  }
  assert.equal(safetyNetCheck(undefined as unknown as string), null);
});
