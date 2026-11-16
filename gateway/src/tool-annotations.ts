// MCP tool annotations (spec 2025-06-18 `ToolAnnotations`): what each tool
// does, for AI clients and directory reviewers (Claude connectors directory,
// ChatGPT apps). They are hints for the client's UI; the gateway still
// enforces risk and human approval on its own (protocol.ts actionRisk).
//
// readOnlyHint   true: never changes anything on the device or account.
// destructiveHint true: may overwrite, delete, stop or run arbitrary code.
// idempotentHint true: the same call twice has no further effect.
// openWorldHint  true: reaches outside the user's own machines (the web).
//
// Every tool must be listed: tool-annotations.test.ts fails for a new tool
// that is missing here or that disagrees with its risk class.

export type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

type Kind = "read" | "write" | "destructive" | "control";

// read: only reads. write: adds or changes without losing data. destructive:
// may overwrite, delete, stop processes or run commands. control: changes only
// the state of a WECOMMANDER session (searches, terminal size), not user data.
const KINDS: Record<string, [Kind, string]> = {
  devices_list: ["read", "List devices"],
  app_errors: ["read", "Recent app errors"],
  system_info: ["read", "System information"],
  health_snapshot: ["read", "Health snapshot"],
  server_overview: ["read", "Server overview"],
  server_disk_usage: ["read", "Disk usage"],
  server_cleanup_scan: ["read", "Find what can be cleaned"],
  server_cleanup_run: ["destructive", "Clean up disk space"],
  server_processes: ["read", "Server processes"],
  server_process_signal: ["destructive", "Signal a process"],
  server_restart_owner: ["destructive", "Restart a container or service"],
  log_query: ["read", "Search logs"],
  policy_info: ["read", "Agent policy"],
  get_recent_tool_calls: ["read", "Recent tool calls"],
  get_usage_stats: ["read", "Usage statistics"],
  fs_list: ["read", "List a folder"],
  fs_stat: ["read", "File information"],
  fs_read: ["read", "Read a file"],
  fs_read_lines: ["read", "Read file lines"],
  image_inspect: ["read", "Inspect an image"],
  docx_inspect: ["read", "Inspect a Word document"],
  docx_read_paragraphs: ["read", "Read Word paragraphs"],
  docx_read_table: ["read", "Read a Word table"],
  pdf_read: ["read", "Read a PDF"],
  xlsx_inspect: ["read", "Inspect an Excel workbook"],
  xlsx_read_range: ["read", "Read Excel cells"],
  xlsx_find: ["read", "Find in an Excel workbook"],
  xlsx_write_cells: ["destructive", "Write Excel cells"],
  fs_read_multiple: ["read", "Read several files"],
  fs_write: ["destructive", "Write a file"],
  fs_append: ["write", "Append to a file"],
  fs_mkdir: ["write", "Create a folder"],
  fs_delete: ["destructive", "Delete a file or folder"],
  fs_move: ["destructive", "Move or rename"],
  fs_tree: ["read", "Folder tree"],
  fs_search: ["read", "Search file names"],
  text_search: ["read", "Search text"],
  code_search: ["read", "Search code"],
  start_search: ["read", "Start a search"],
  get_more_search_results: ["read", "Search results"],
  list_searches: ["read", "List searches"],
  stop_search: ["control", "Stop a search"],
  pause_search: ["control", "Pause a search"],
  resume_search: ["control", "Resume a search"],
  fs_replace: ["destructive", "Replace text in a file"],
  fs_versions: ["read", "File versions"],
  fs_undo: ["destructive", "Undo a file change"],
  process_exec: ["destructive", "Run a command"],
  process_list: ["read", "List processes"],
  process_kill: ["destructive", "Stop a process"],
  task_start: ["destructive", "Start a background task"],
  task_status: ["read", "Task status"],
  task_cancel: ["destructive", "Cancel a task"],
  task_list: ["read", "List tasks"],
  terminal_start: ["destructive", "Open a terminal"],
  terminal_input: ["destructive", "Type into a terminal"],
  terminal_read: ["read", "Read terminal output"],
  terminal_read_page: ["read", "Read terminal history"],
  terminal_resize: ["control", "Resize a terminal"],
  terminal_stop: ["destructive", "Close a terminal"],
  terminal_list: ["read", "List terminals"],
  // Desktop Commander compatible names (they map to the tools above).
  read_file: ["read", "Read a file"],
  read_multiple_files: ["read", "Read several files"],
  write_file: ["destructive", "Write a file"],
  list_directory: ["read", "List a folder"],
  create_directory: ["write", "Create a folder"],
  move_file: ["destructive", "Move or rename"],
  get_file_info: ["read", "File information"],
  edit_block: ["destructive", "Edit part of a file"],
  url_fetch: ["read", "Fetch a web page"],
};

/** Reaches the public web rather than the user's own machines. */
const OPEN_WORLD = new Set(["url_fetch"]);
/** Same call twice, same result (besides reads). */
const IDEMPOTENT = new Set(["fs_mkdir", "create_directory", "terminal_resize", "stop_search", "pause_search", "resume_search"]);

export function annotationKind(name: string): Kind | undefined {
  return KINDS[name]?.[0];
}

export function toolAnnotations(name: string): ToolAnnotations {
  const entry = KINDS[name];
  if (!entry) throw new Error(`tool ${name} has no annotations: add it to tool-annotations.ts`);
  const [kind, title] = entry;
  return {
    title,
    readOnlyHint: kind === "read",
    destructiveHint: kind === "destructive",
    idempotentHint: kind === "read" || IDEMPOTENT.has(name),
    openWorldHint: OPEN_WORLD.has(name),
  };
}

/** A tool definition with its annotations (and the title the spec puts at the top level too). */
export function annotate<T extends { name: string }>(tool: T): T & { title: string; annotations: ToolAnnotations } {
  const annotations = toolAnnotations(tool.name);
  return { ...tool, title: annotations.title, annotations };
}
