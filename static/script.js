document.addEventListener("DOMContentLoaded", function () {
    const $ = id => document.getElementById(id);

    const BRANCH_COLORS = ["#818cf8", "#34d399", "#fbbf24", "#f472b6", "#38bdf8", "#fb923c", "#a78bfa", "#a3e635"];

    let state = null;
    let selectedCommit = null;
    const uncheckedFiles = new Set();  // staged files the user deselected for the next commit
    const workdir = {};                // files written in the terminal but not yet staged
    let conflict = null;               // merge in progress: { data, values: {file: resolved text}, fromTerminal }

    // ---------- helpers ----------

    function esc(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function plural(n, word) {
        return `${n} ${word}${n === 1 ? "" : "s"}`;
    }

    function branchColor(branch) {
        const index = Object.keys(state?.branches || {}).indexOf(branch);
        return BRANCH_COLORS[Math.max(0, index) % BRANCH_COLORS.length];
    }

    function findCommit(id) {
        return state?.commits.find(c => c.id === id);
    }

    function toast(message, ok = true) {
        const el = document.createElement("div");
        el.className = `pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur transition-all duration-300 ${
            ok ? "border-emerald-400/20 bg-emerald-950/80 text-emerald-100" : "border-rose-400/20 bg-rose-950/80 text-rose-100"
        }`;
        el.innerHTML = `<i class="ph-bold ${ok ? "ph-check-circle text-emerald-400" : "ph-warning-circle text-rose-400"} mt-0.5 text-base"></i><span>${esc(message)}</span>`;
        $("toasts").appendChild(el);
        setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(8px)"; }, 3500);
        setTimeout(() => el.remove(), 3900);
    }

    async function api(path, body = {}, { quiet = false } = {}) {
        try {
            const response = await fetch(path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await response.json();
            if (data.state) render(data.state);
            if (data.conflict) openConflict(data.conflict, { fromTerminal: quiet });
            if (!quiet) toast(data.message, data.ok);
            return data;
        } catch (err) {
            console.error(`Request to ${path} failed:`, err);
            const data = { ok: false, message: "Could not reach the server. Is the Flask app running?" };
            if (!quiet) toast(data.message, false);
            return data;
        }
    }

    async function fetchState() {
        try {
            render(await (await fetch("/state")).json());
        } catch (err) {
            console.error("Error fetching state:", err);
            toast("Could not load the repository state.", false);
        }
    }

    // ---------- rendering ----------

    function render(newState) {
        state = newState;
        const current = state.current_branch;

        $("current-branch").textContent = current;
        $("previous-branch").textContent = state.previous_branch || "none";
        document.querySelectorAll("[data-current-branch]").forEach(el => { el.textContent = current; });
        $("stat-commits").textContent = state.branches[current].length;
        $("stat-branches").textContent = Object.keys(state.branches).length;
        $("stat-staged").textContent = Object.keys(state.staging_area).length;

        if (selectedCommit && !findCommit(selectedCommit)) selectedCommit = null;

        renderFiles();
        renderStaging();
        renderBranches();
        renderGraph();
        renderHistory();
        renderDetails();
    }

    function renderFiles() {
        const names = Object.keys(state.working_tree).sort();
        $("fileList").innerHTML = names.length
            ? names.map(name => `
                <button type="button" data-edit="${esc(name)}" class="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-300 hover:bg-indigo-500/20 hover:text-white">
                    <i class="ph ph-file-text"></i>${esc(name)}
                </button>`).join("")
            : `<p class="text-xs text-slate-600">No committed files yet.</p>`;
    }

    function renderStaging() {
        const staged = Object.keys(state.staging_area);
        // forget deselections for files that are no longer staged
        [...uncheckedFiles].forEach(f => { if (!(f in state.staging_area)) uncheckedFiles.delete(f); });

        $("stagingList").innerHTML = staged.length
            ? staged.map(name => {
                const isNew = !(name in state.working_tree);
                return `
                <li class="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                    <input type="checkbox" class="h-4 w-4 shrink-0 accent-indigo-500" data-stage-check="${esc(name)}" ${uncheckedFiles.has(name) ? "" : "checked"} aria-label="Include ${esc(name)} in commit">
                    <span class="min-w-0 flex-1 truncate font-mono text-sm text-slate-200" title="${esc(name)}">${esc(name)}</span>
                    <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isNew ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}">${isNew ? "new" : "modified"}</span>
                    <button type="button" data-unstage="${esc(name)}" class="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-rose-300" title="Unstage">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </li>`;
            }).join("")
            : `<li class="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">Nothing staged. Stage a file in step 1.</li>`;

        $("selectAll").checked = staged.length > 0 && uncheckedFiles.size === 0;
        $("selectAll").disabled = staged.length === 0;
        updateCommitButton();
    }

    function selectedStagedFiles() {
        return Object.keys(state.staging_area).filter(f => !uncheckedFiles.has(f));
    }

    function updateCommitButton() {
        $("commitButton").disabled = selectedStagedFiles().length === 0;
    }

    function renderBranches() {
        const current = state.current_branch;
        const names = Object.keys(state.branches);

        $("branchList").innerHTML = names.map(name => {
            const isCurrent = name === current;
            return `
            <li class="flex items-center gap-3 rounded-lg px-3 py-2 ${isCurrent ? "bg-indigo-500/10 ring-1 ring-indigo-400/30" : "bg-white/[0.03]"}">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${branchColor(name)}"></span>
                <span class="min-w-0 flex-1 truncate font-mono text-sm ${isCurrent ? "text-white" : "text-slate-300"}">${esc(name)}</span>
                <span class="text-xs text-slate-500">${plural(state.branches[name].length, "commit")}</span>
                ${isCurrent
                    ? `<span class="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-bold text-indigo-200">HEAD</span>`
                    : `<button type="button" data-switch="${esc(name)}" class="rounded-md px-2 py-0.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20">Switch</button>`}
            </li>`;
        }).join("");

        const others = names.filter(n => n !== current);
        $("mergeSource").innerHTML = others.length
            ? others.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")
            : `<option value="">No other branches</option>`;
        $("mergeSource").disabled = $("mergeButton").disabled = others.length === 0;
    }

    function renderGraph() {
        const wrap = $("graphWrap");
        const commits = state.commits;
        const lanes = Object.keys(state.branches);

        if (!commits.length) {
            wrap.innerHTML = `
                <div class="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-slate-500">
                    <i class="ph ph-git-commit text-3xl text-slate-600"></i>
                    No commits yet. Stage a file and make your first commit.
                </div>`;
            return;
        }

        const COL = 64, ROW = 64, LEFT = 130, TOP = 40, R = 9;
        const width = LEFT + commits.length * COL + 40;
        const height = TOP + lanes.length * ROW - 10;
        const pos = {};

        commits.forEach((c, i) => {
            const lane = Math.max(0, lanes.indexOf(c.branch));
            pos[c.id] = { x: LEFT + i * COL, y: TOP + lane * ROW, color: BRANCH_COLORS[lane % BRANCH_COLORS.length] };
        });

        const parts = [];

        // lane guides and labels
        lanes.forEach((name, lane) => {
            const y = TOP + lane * ROW;
            const color = BRANCH_COLORS[lane % BRANCH_COLORS.length];
            const label = name.length > 14 ? name.slice(0, 13) + "…" : name;
            parts.push(`<line x1="${LEFT - 20}" y1="${y}" x2="${width - 20}" y2="${y}" stroke="${color}" stroke-opacity="0.08" stroke-width="2"/>`);
            parts.push(`<text x="12" y="${y + 4}" fill="${color}" font-size="12" font-weight="600" font-family="JetBrains Mono, monospace"><title>${esc(name)}</title>${esc(label)}</text>`);
        });

        // edges: first parent uses the child's color, other parents (merges) use the parent's color
        commits.forEach(c => {
            const to = pos[c.id];
            (c.parents || []).forEach((parentId, idx) => {
                const from = pos[parentId];
                if (!from) return;
                const color = idx === 0 ? to.color : from.color;
                const d = from.y === to.y
                    ? `M${from.x} ${from.y} L${to.x} ${to.y}`
                    : `M${from.x} ${from.y} C${from.x + COL * 0.6} ${from.y}, ${to.x - COL * 0.6} ${to.y}, ${to.x} ${to.y}`;
                parts.push(`<path d="${d}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`);
            });
        });

        // merge in progress: connect the two clashing tips with a red "conflict" link
        const clash = conflict && conflict.data.target === state.current_branch && conflict.data;
        if (clash && pos[clash.ours_head] && pos[clash.theirs_head]) {
            const a = pos[clash.ours_head], b = pos[clash.theirs_head];
            const mx = Math.max(a.x, b.x) + COL * 0.7, my = (a.y + b.y) / 2;
            parts.push(`<path d="M${a.x} ${a.y} Q${mx} ${a.y} ${mx} ${my} Q${mx} ${b.y} ${b.x} ${b.y}" stroke="#fb7185" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`);
            parts.push(`<g><rect x="${mx - 34}" y="${my - 10}" width="68" height="18" rx="9" fill="#4c0519" stroke="#fb7185" stroke-opacity="0.6"/>
                <text x="${mx}" y="${my + 3}" text-anchor="middle" fill="#fecdd3" font-size="10" font-weight="700" font-family="JetBrains Mono, monospace">CONFLICT</text></g>`);
        }
        const clashing = clash ? [clash.ours_head, clash.theirs_head] : [];

        // nodes
        const headId = state.branches[state.current_branch].at(-1);
        commits.forEach(c => {
            const { x, y, color } = pos[c.id];
            const selected = c.id === selectedCommit;
            parts.push(`
                <g data-commit="${c.id}" class="cursor-pointer" role="button" tabindex="0" aria-label="Commit ${c.id}: ${esc(c.message)}">
                    <title>${c.id} · ${esc(c.message)}</title>
                    ${selected ? `<circle cx="${x}" cy="${y}" r="${R + 6}" fill="${color}" fill-opacity="0.2"/>` : ""}
                    ${clashing.includes(c.id) ? `<circle cx="${x}" cy="${y}" r="${R + 7}" fill="#fb7185" fill-opacity="0.18" stroke="#fb7185" stroke-width="2"><animate attributeName="r" values="${R + 5};${R + 9};${R + 5}" dur="1.6s" repeatCount="indefinite"/></circle>` : ""}
                    ${c.id === headId ? `<circle cx="${x}" cy="${y}" r="${R + 4}" fill="none" stroke="#fff" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="3 3"/>` : ""}
                    <circle cx="${x}" cy="${y}" r="${R}" fill="#0f1524" stroke="${color}" stroke-width="3"/>
                    ${c.type === "merge" ? `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>` : ""}
                    <text x="${x}" y="${y + R + 15}" text-anchor="middle" fill="#64748b" font-size="10" font-family="JetBrains Mono, monospace">${c.id}</text>
                </g>`);
        });

        // branch tip tags, stacked above the commit each branch points to
        const tagsByCommit = {};
        lanes.forEach(name => {
            const tip = state.branches[name].at(-1);
            if (tip) (tagsByCommit[tip] ||= []).push(name);
        });
        Object.entries(tagsByCommit).forEach(([id, names]) => {
            const { x, y } = pos[id];
            names.forEach((name, k) => {
                const label = (name === state.current_branch ? "HEAD → " : "") + name;
                const w = label.length * 6.6 + 12;
                const ty = y - R - 10 - k * 18;
                parts.push(`
                    <g>
                        <rect x="${x - w / 2}" y="${ty - 11}" width="${w}" height="15" rx="4" fill="#0f1524"/>
                        <rect x="${x - w / 2}" y="${ty - 11}" width="${w}" height="15" rx="4" fill="${branchColor(name)}" fill-opacity="0.18" stroke="${branchColor(name)}" stroke-opacity="0.5"/>
                        <text x="${x}" y="${ty}" text-anchor="middle" fill="${branchColor(name)}" font-size="10" font-weight="600" font-family="JetBrains Mono, monospace">${esc(label)}</text>
                    </g>`);
            });
        });

        const maxStack = Math.max(1, ...Object.values(tagsByCommit).map(n => n.length));
        const extraTop = Math.max(0, (maxStack - 1) * 18);
        wrap.innerHTML = `<svg width="${width}" height="${height + extraTop}" viewBox="0 ${-extraTop} ${width} ${height + extraTop}" class="block">${parts.join("")}</svg>`;

        // keep the newest commit in view
        wrap.scrollLeft = wrap.scrollWidth;
    }

    function renderHistory() {
        const ids = [...state.branches[state.current_branch]].reverse();
        $("commitList").innerHTML = ids.length
            ? ids.map((id, i) => {
                const c = findCommit(id);
                if (!c) return "";
                const selected = id === selectedCommit;
                return `
                <li>
                    <button type="button" data-commit="${c.id}" class="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition ${selected ? "bg-indigo-500/15 ring-1 ring-indigo-400/30" : "bg-white/[0.03] hover:bg-white/[0.06]"}">
                        <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style="background:${branchColor(c.branch)}"></span>
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-slate-100">${esc(c.message)}</span>
                            <span class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                <span class="font-mono text-amber-300/80">${c.id}</span>
                                <span>${plural(Object.keys(c.files).length, "file")}</span>
                                ${c.type === "merge" ? `<span class="rounded bg-violet-500/15 px-1.5 text-violet-300">merge</span>` : ""}
                                ${c.resolved_conflicts?.length ? `<span class="rounded bg-rose-500/15 px-1.5 text-rose-300">conflict resolved</span>` : ""}
                                ${i === 0 ? `<span class="rounded bg-indigo-500/20 px-1.5 font-semibold text-indigo-200">HEAD</span>` : ""}
                            </span>
                        </span>
                    </button>
                </li>`;
            }).join("")
            : `<li class="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">No commits on this branch yet.</li>`;
    }

    function renderDetails() {
        const c = selectedCommit && findCommit(selectedCommit);
        const box = $("commitDetails");
        if (!c) {
            box.innerHTML = `<p class="text-slate-500">Select a commit in the graph or history.</p>`;
            return;
        }
        const when = c.timestamp ? new Date(c.timestamp * 1000).toLocaleTimeString() : "";
        box.innerHTML = `
            <p class="text-base font-medium text-white">${esc(c.message)}</p>
            <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt class="text-slate-500">commit</dt><dd class="font-mono text-amber-300">${c.id}</dd>
                <dt class="text-slate-500">branch</dt><dd class="font-mono" style="color:${branchColor(c.branch)}">${esc(c.branch)}</dd>
                <dt class="text-slate-500">parents</dt>
                <dd class="font-mono">${(c.parents || []).length
                    ? c.parents.map(p => `<button type="button" data-commit="${p}" class="mr-2 text-indigo-300 hover:underline">${p}</button>`).join("")
                    : `<span class="text-slate-500">none (root commit)</span>`}</dd>
                ${when ? `<dt class="text-slate-500">time</dt><dd class="text-slate-300">${when}</dd>` : ""}
                ${c.resolved_conflicts?.length ? `<dt class="text-slate-500">conflicts</dt><dd class="font-mono text-rose-300">${c.resolved_conflicts.map(esc).join(", ")} <span class="font-sans text-slate-500">(resolved by hand)</span></dd>` : ""}
            </dl>
            <p class="mt-4 text-xs font-medium uppercase tracking-wider text-slate-500">Changed files</p>
            <div class="mt-2 flex flex-col gap-2">
                ${Object.entries(c.files).map(([name, content]) => `
                    <div class="overflow-hidden rounded-lg border border-white/5">
                        <div class="bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-300">${esc(name)}</div>
                        <pre class="scrollbar-thin max-h-40 overflow-auto bg-[#0f1524] px-3 py-2 font-mono text-xs text-slate-400">${esc(content)}</pre>
                    </div>`).join("") || `<p class="text-xs text-slate-500">No file changes.</p>`}
            </div>`;
    }

    function selectCommit(id) {
        selectedCommit = id;
        renderGraph();
        renderHistory();
        renderDetails();
    }

    // ---------- merge conflicts ----------

    const MARKER_RE = /^(<{7}|={7}|>{7})/m;

    // Splits both versions into shared leading lines, the differing middle of each side, and shared trailing lines
    function splitHunk(ours, theirs) {
        const a = ours.split("\n"), b = theirs.split("\n");
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let end = 0;
        while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
        return {
            before: a.slice(0, start),
            ours: a.slice(start, a.length - end),
            theirs: b.slice(start, b.length - end),
            after: a.slice(a.length - end),
        };
    }

    function conflictMarkers(file, data) {
        const h = splitHunk(file.ours, file.theirs);
        return [...h.before, `<<<<<<< HEAD (${data.target})`, ...h.ours, "=======", ...h.theirs, `>>>>>>> ${data.source}`, ...h.after].join("\n");
    }

    function keepBoth(file) {
        const h = splitHunk(file.ours, file.theirs);
        return [...h.before, ...h.ours, ...h.theirs, ...h.after].join("\n");
    }

    function isResolved(name) {
        return !MARKER_RE.test(conflict.values[name] ?? "");
    }

    // Shows a file's lines, tinting the ones that differ from the other side(s)
    function renderLines(text, compareTo, tint) {
        if (text === null || text === undefined) {
            return `<p class="px-3 py-2 italic text-slate-600">File did not exist yet</p>`;
        }
        const others = new Set(compareTo.flatMap(t => (t ?? "").split("\n")));
        return text.split("\n").map(line => {
            const changed = !others.has(line);
            return `<div class="whitespace-pre-wrap break-all px-3 ${changed ? tint : ""}">${esc(line) || "&nbsp;"}</div>`;
        }).join("");
    }

    function openConflict(data, { fromTerminal = false } = {}) {
        conflict = { data, values: {}, fromTerminal };
        data.files.forEach(f => { conflict.values[f.name] = conflictMarkers(f, data); });

        const ours = esc(data.target), theirs = esc(data.source);
        const oursColor = branchColor(data.target), theirsColor = branchColor(data.source);
        const pill = (name, color) => `<span class="rounded px-1.5 font-mono" style="color:${color};background:${color}22">${name}</span>`;

        $("conflictSummary").innerHTML = `Since they split, ${pill(ours, oursColor)} and ${pill(theirs, theirsColor)} both changed
            ${data.files.length === 1 ? "the same file" : `the same ${data.files.length} files`} in different ways. Git can't guess which change is right, so you decide.`;

        $("conflictBody").innerHTML = `
            <div class="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.03] p-4 text-xs text-slate-400">
                <span class="rounded-lg bg-white/5 px-2.5 py-1.5"><i class="ph ph-git-commit"></i> common ancestor</span>
                <i class="ph-bold ph-arrow-right text-slate-600"></i>
                <span class="flex flex-col gap-1.5">
                    <span>${pill(ours, oursColor)} changed <span class="font-mono text-slate-300">${data.files.map(f => esc(f.name)).join(", ")}</span></span>
                    <span>${pill(theirs, theirsColor)} changed <span class="font-mono text-slate-300">${data.files.map(f => esc(f.name)).join(", ")}</span></span>
                </span>
                <i class="ph-bold ph-arrow-right text-slate-600"></i>
                <span class="rounded-lg bg-rose-500/15 px-2.5 py-1.5 font-semibold text-rose-300"><i class="ph-bold ph-lightning"></i> conflict</span>
            </div>
            ${data.files.map((f, i) => `
            <article class="mb-6 overflow-hidden rounded-xl border border-white/5 last:mb-0" data-conflict-file="${esc(f.name)}">
                <header class="flex items-center gap-3 bg-white/[0.03] px-4 py-3">
                    <i class="ph ph-file-text text-slate-400"></i>
                    <span class="font-mono text-sm text-white">${esc(f.name)}</span>
                    <span class="text-xs text-slate-500">file ${i + 1} of ${data.files.length}</span>
                    <span data-status class="ml-auto"></span>
                </header>
                <div class="grid grid-cols-1 gap-px bg-white/5 font-mono text-xs md:grid-cols-3">
                    <div class="bg-[#0f1524]">
                        <p class="border-b border-white/5 px-3 py-2 font-sans text-[11px] font-semibold uppercase tracking-wider text-slate-500">Original <span class="normal-case tracking-normal text-slate-600">· before the split</span></p>
                        <div class="max-h-48 overflow-auto py-2 text-slate-500">${renderLines(f.base, [f.ours, f.theirs], "bg-white/5 text-slate-400 line-through decoration-slate-600")}</div>
                    </div>
                    <div class="bg-[#0f1524]">
                        <p class="border-b border-white/5 px-3 py-2 font-sans text-[11px] font-semibold uppercase tracking-wider" style="color:${oursColor}">Ours · ${ours} <span class="normal-case tracking-normal text-slate-500">(HEAD)</span></p>
                        <div class="max-h-48 overflow-auto py-2 text-slate-300">${renderLines(f.ours, [f.base], "bg-amber-400/10 text-amber-100")}</div>
                    </div>
                    <div class="bg-[#0f1524]">
                        <p class="border-b border-white/5 px-3 py-2 font-sans text-[11px] font-semibold uppercase tracking-wider" style="color:${theirsColor}">Theirs · ${theirs} <span class="normal-case tracking-normal text-slate-500">(incoming)</span></p>
                        <div class="max-h-48 overflow-auto py-2 text-slate-300">${renderLines(f.theirs, [f.base], "bg-sky-400/10 text-sky-100")}</div>
                    </div>
                </div>
                <div class="border-t border-white/5 p-4">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="mr-1 text-xs font-medium text-slate-400">Resolve:</span>
                        <button type="button" data-pick="ours" class="btn btn-ghost py-1.5 text-xs">Keep ${ours}</button>
                        <button type="button" data-pick="theirs" class="btn btn-ghost py-1.5 text-xs">Keep ${theirs}</button>
                        <button type="button" data-pick="both" class="btn btn-ghost py-1.5 text-xs">Keep both</button>
                        <button type="button" data-pick="markers" class="btn btn-ghost py-1.5 text-xs text-slate-500">Reset</button>
                    </div>
                    <label class="mt-3 block text-xs text-slate-500">Result, as Git writes it into the file. Edit it freely, then remove the <code class="font-mono text-rose-300">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> <code class="font-mono text-rose-300">=======</code> <code class="font-mono text-rose-300">&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> lines.</label>
                    <textarea data-result rows="7" spellcheck="false" class="field mt-2 resize-y font-mono text-xs"></textarea>
                </div>
            </article>`).join("")}`;

        $("conflictBody").querySelectorAll("[data-conflict-file]").forEach(el => {
            el.querySelector("[data-result]").value = conflict.values[el.dataset.conflictFile];
        });
        updateConflictStatus();

        const modal = $("conflictModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        $("conflictBody").scrollTop = 0;
        renderGraph();
        modal.querySelector("[data-pick]")?.focus();
    }

    function updateConflictStatus() {
        const names = conflict.data.files.map(f => f.name);
        let resolved = 0;
        $("conflictBody").querySelectorAll("[data-conflict-file]").forEach(el => {
            const ok = isResolved(el.dataset.conflictFile);
            if (ok) resolved++;
            el.classList.toggle("border-rose-400/30", !ok);
            el.classList.toggle("border-emerald-400/30", ok);
            el.querySelector("[data-status]").innerHTML = ok
                ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300"><i class="ph-bold ph-check"></i> resolved</span>`
                : `<span class="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300"><i class="ph-bold ph-warning"></i> conflict</span>`;
        });
        $("conflictProgress").innerHTML = resolved === names.length
            ? `<span class="text-emerald-300"><i class="ph-bold ph-check-circle"></i> All conflicts resolved. Ready to create the merge commit.</span>`
            : `${resolved} of ${plural(names.length, "file")} resolved`;
        $("completeMerge").disabled = resolved !== names.length;
    }

    function closeConflict() {
        conflict = null;
        $("conflictModal").classList.add("hidden");
        $("conflictModal").classList.remove("flex");
        if (state) renderGraph();
    }

    function abortMerge() {
        if (!conflict) return;
        const { data, fromTerminal } = conflict;
        closeConflict();
        const message = `Merge of '${data.source}' into '${data.target}' aborted. Nothing was changed.`;
        fromTerminal ? print(message, "text-amber-300") : toast(message, true);
    }

    $("conflictBody").addEventListener("click", e => {
        const btn = e.target.closest("[data-pick]");
        if (!btn) return;
        const card = btn.closest("[data-conflict-file]");
        const file = conflict.data.files.find(f => f.name === card.dataset.conflictFile);
        const pick = btn.dataset.pick;
        const value = pick === "ours" ? file.ours
            : pick === "theirs" ? file.theirs
            : pick === "both" ? keepBoth(file)
            : conflictMarkers(file, conflict.data);
        conflict.values[file.name] = value;
        card.querySelector("[data-result]").value = value;
        updateConflictStatus();
    });

    $("conflictBody").addEventListener("input", e => {
        if (!e.target.matches("[data-result]")) return;
        conflict.values[e.target.closest("[data-conflict-file]").dataset.conflictFile] = e.target.value;
        updateConflictStatus();
    });

    $("completeMerge").addEventListener("click", async () => {
        const { data: info, values, fromTerminal } = conflict;
        $("completeMerge").disabled = true;
        closeConflict();
        const data = await api("/merge", { source_branch: info.source, resolutions: values }, { quiet: fromTerminal });
        if (fromTerminal && !data.conflict) print(data.message, data.ok ? "text-emerald-300" : "text-rose-300");
        if (data.ok) selectCommit(state.branches[state.current_branch].at(-1));
    });

    document.querySelectorAll("[data-abort-merge]").forEach(btn => btn.addEventListener("click", abortMerge));
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && conflict) abortMerge();
    });

    // ---------- UI actions ----------

    $("addForm").addEventListener("submit", async e => {
        e.preventDefault();
        const filename = $("filename").value.trim();
        const content = $("content").value;
        if (!filename || !content.trim()) {
            toast("Enter a filename and some content.", false);
            return;
        }
        const data = await api("/add", { filename, content });
        if (data.ok) {
            delete workdir[filename];
            $("filename").value = "";
            $("content").value = "";
            $("filename").focus();
        }
    });

    $("fileList").addEventListener("click", e => {
        const name = e.target.closest("[data-edit]")?.dataset.edit;
        if (!name) return;
        $("filename").value = name;
        $("content").value = state.staging_area[name] ?? state.working_tree[name] ?? "";
        $("content").focus();
    });

    $("stagingList").addEventListener("change", e => {
        const name = e.target.dataset.stageCheck;
        if (name === undefined) return;
        e.target.checked ? uncheckedFiles.delete(name) : uncheckedFiles.add(name);
        $("selectAll").checked = uncheckedFiles.size === 0;
        updateCommitButton();
    });

    $("stagingList").addEventListener("click", e => {
        const name = e.target.closest("[data-unstage]")?.dataset.unstage;
        if (name) api("/unstage", { filename: name });
    });

    $("selectAll").addEventListener("change", e => {
        Object.keys(state.staging_area).forEach(f => (e.target.checked ? uncheckedFiles.delete(f) : uncheckedFiles.add(f)));
        renderStaging();
    });

    $("commitForm").addEventListener("submit", async e => {
        e.preventDefault();
        const message = $("commitMessage").value.trim();
        if (!message) {
            toast("Write a commit message first.", false);
            $("commitMessage").focus();
            return;
        }
        const data = await api("/commit", { message, committed_files: selectedStagedFiles() });
        if (data.ok) $("commitMessage").value = "";
    });

    $("branchForm").addEventListener("submit", async e => {
        e.preventDefault();
        const branch_name = $("branchName").value.trim();
        if (!branch_name) {
            toast("Enter a branch name.", false);
            return;
        }
        const data = await api("/branch", { branch_name, checkout: $("branchCheckout").checked });
        if (data.ok) $("branchName").value = "";
    });

    $("branchList").addEventListener("click", e => {
        const name = e.target.closest("[data-switch]")?.dataset.switch;
        if (name) api("/switch_branch", { target_branch: name });
    });

    $("mergeForm").addEventListener("submit", e => {
        e.preventDefault();
        const source_branch = $("mergeSource").value;
        if (source_branch) api("/merge", { source_branch });
    });

    $("resetBtn").addEventListener("click", async () => {
        if (!confirm("Reset the repository? All commits and branches will be removed.")) return;
        Object.keys(workdir).forEach(k => delete workdir[k]);
        uncheckedFiles.clear();
        selectedCommit = null;
        await api("/reset");
        clearTerminal();
    });

    function onCommitClick(e) {
        const id = e.target.closest("[data-commit]")?.dataset.commit;
        if (id) selectCommit(id);
    }
    $("graphWrap").addEventListener("click", onCommitClick);
    $("commitList").addEventListener("click", onCommitClick);
    $("commitDetails").addEventListener("click", onCommitClick);
    $("graphWrap").addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCommitClick(e); }
    });

    // ---------- terminal ----------

    const term = $("terminal");
    const termInput = $("terminalInput");
    const termHistory = [];
    let historyIndex = 0;

    const HELP = [
        ["echo \"text\" > file", "write a file in the working directory (>> appends)"],
        ["ls / cat <file>", "list files / show a file"],
        ["git status", "show staged and unstaged files"],
        ["git add <file> | .", "stage files you wrote with echo"],
        ["git restore --staged <file>", "unstage a file"],
        ["git commit -m \"msg\"", "commit everything staged"],
        ["git log [--oneline]", "show history of the current branch"],
        ["git branch [name]", "list branches or create one"],
        ["git checkout [-b] <branch>", "switch branch (-b creates it); git switch [-c] works too"],
        ["git merge <branch>", "merge a branch into the current one"],
        ["git merge --abort", "cancel a merge that has conflicts"],
        ["clear", "clear the terminal"],
    ];

    function print(text, cls = "text-slate-300") {
        const line = document.createElement("div");
        line.className = `whitespace-pre-wrap break-words ${cls}`;
        line.textContent = text;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
    }

    function clearTerminal() {
        term.innerHTML = "";
        print("Welcome to the GitSim terminal. Type 'help' to see available commands.", "text-slate-500");
        print('Try: echo "hello" > readme.md  →  git add readme.md  →  git commit -m "first commit"', "text-slate-500");
    }

    function tokenize(line) {
        const tokens = [];
        const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(>>|>|[^\s>]+)/g;
        let m;
        while ((m = re.exec(line))) {
            if (m[1] !== undefined) tokens.push(m[1].replace(/\\(["\\])/g, "$1"));
            else if (m[2] !== undefined) tokens.push(m[2]);
            else tokens.push(m[3]);
        }
        return tokens;
    }

    function fileContent(name) {
        return workdir[name] ?? state.staging_area[name] ?? state.working_tree[name];
    }

    async function runGit(args) {
        const [sub, ...rest] = args;
        const current = state.current_branch;
        const report = data => print(data.message, data.ok ? "text-emerald-300" : "text-rose-300");

        switch (sub) {
            case "status": {
                print(`On branch ${current}`);
                const staged = Object.keys(state.staging_area);
                const unstaged = Object.keys(workdir);
                if (staged.length) {
                    print("Changes to be committed:");
                    staged.forEach(f => print(`\t${f in state.working_tree ? "modified:" : "new file:"}   ${f}`, "text-emerald-300"));
                }
                if (unstaged.length) {
                    print('Changes not staged for commit (use "git add <file>"):');
                    unstaged.forEach(f => print(`\t${f in state.working_tree || f in state.staging_area ? "modified:" : "untracked:"}  ${f}`, "text-rose-300"));
                }
                if (!staged.length && !unstaged.length) print("nothing to commit, working tree clean");
                return;
            }
            case "add": {
                if (!rest.length) return print("Nothing specified, nothing added. Try: git add <file>", "text-amber-300");
                const all = rest.some(a => a === "." || a === "-A" || a === "--all");
                const targets = all ? Object.keys(workdir) : rest;
                if (!targets.length) return print("No changes to add. Write a file first with: echo \"text\" > file", "text-amber-300");
                for (const name of targets) {
                    if (!(name in workdir)) {
                        print(name in state.working_tree || name in state.staging_area
                            ? `'${name}' has no new changes. Edit it with: echo "text" > ${name}`
                            : `fatal: pathspec '${name}' did not match any files`, "text-rose-300");
                        continue;
                    }
                    const data = await api("/add", { filename: name, content: workdir[name] }, { quiet: true });
                    if (data.ok) delete workdir[name];
                    report(data);
                }
                return;
            }
            case "restore":
            case "reset": {
                const files = rest.filter(a => a !== "--staged" && a !== "HEAD");
                if (sub === "restore" && !rest.includes("--staged")) return print("Only 'git restore --staged <file>' is supported.", "text-amber-300");
                const targets = files.length ? files : Object.keys(state.staging_area);
                if (!targets.length) return print("Nothing is staged.");
                for (const name of targets) report(await api("/unstage", { filename: name }, { quiet: true }));
                return;
            }
            case "commit": {
                const mIndex = rest.findIndex(a => a === "-m" || a === "-am");
                const message = mIndex >= 0 ? rest[mIndex + 1] : undefined;
                if (!message) return print('error: a message is required. Usage: git commit -m "message"', "text-rose-300");
                report(await api("/commit", { message }, { quiet: true }));
                return;
            }
            case "log": {
                const ids = [...state.branches[current]].reverse();
                if (!ids.length) return print(`fatal: your current branch '${current}' does not have any commits yet`, "text-rose-300");
                const oneline = rest.includes("--oneline");
                ids.forEach((id, i) => {
                    const c = findCommit(id);
                    const tag = i === 0 ? ` (HEAD -> ${current})` : "";
                    if (oneline) {
                        print(`${c.id}${tag} ${c.message}`, "text-slate-300");
                    } else {
                        print(`commit ${c.id}${tag}`, "text-amber-300");
                        if (c.type === "merge") print(`Merge: ${c.parents.join(" ")}`);
                        print(`\n    ${c.message}\n`);
                    }
                });
                return;
            }
            case "branch": {
                if (!rest.length) {
                    Object.keys(state.branches).forEach(b => print(`${b === current ? "* " : "  "}${b}`, b === current ? "text-emerald-300" : "text-slate-300"));
                    return;
                }
                if (rest[0].startsWith("-")) return print(`Option '${rest[0]}' is not supported in this simulator.`, "text-amber-300");
                report(await api("/branch", { branch_name: rest[0], checkout: false }, { quiet: true }));
                return;
            }
            case "checkout":
            case "switch": {
                const createFlag = sub === "checkout" ? "-b" : "-c";
                if (rest[0] === createFlag) {
                    if (!rest[1]) return print(`usage: git ${sub} ${createFlag} <branch>`, "text-rose-300");
                    report(await api("/branch", { branch_name: rest[1], checkout: true }, { quiet: true }));
                    return;
                }
                if (!rest[0]) return print(`usage: git ${sub} <branch>`, "text-rose-300");
                report(await api("/switch_branch", { target_branch: rest[0] }, { quiet: true }));
                return;
            }
            case "merge": {
                if (rest[0] === "--abort") {
                    if (!conflict) return print("fatal: There is no merge to abort.", "text-rose-300");
                    abortMerge();
                    return;
                }
                if (!rest[0]) return print("usage: git merge <branch>", "text-rose-300");
                const data = await api("/merge", { source_branch: rest[0] }, { quiet: true });
                if (data.conflict) {
                    data.conflict.files.forEach(f => {
                        print(`Auto-merging ${f.name}`);
                        print(`CONFLICT (content): Merge conflict in ${f.name}`, "text-rose-300");
                    });
                    print("Automatic merge failed; fix conflicts and then commit the result.", "text-rose-300");
                    print("Opened the conflict resolver. (git merge --abort to cancel)", "text-slate-500");
                } else {
                    report(data);
                }
                return;
            }
            case undefined:
                return print("usage: git <command>. Type 'help' for the list of commands.", "text-amber-300");
            default:
                print(`git: '${sub}' is not a git command in this simulator. Type 'help'.`, "text-rose-300");
        }
    }

    async function runCommand(line) {
        const tokens = tokenize(line);
        const [cmd, ...args] = tokens;

        if (cmd === "help") {
            HELP.forEach(([c, d]) => print(`  ${c.padEnd(30)} ${d}`, "text-slate-400"));
        } else if (cmd === "clear") {
            term.innerHTML = "";
        } else if (cmd === "git") {
            await runGit(args);
        } else if (cmd === "echo") {
            const opIndex = args.findIndex(a => a === ">" || a === ">>");
            const text = args.slice(0, opIndex >= 0 ? opIndex : undefined).join(" ").replace(/\\n/g, "\n");
            if (opIndex < 0) return print(text);
            const target = args[opIndex + 1];
            if (!target) return print("syntax error: missing filename after '>'", "text-rose-300");
            const base = args[opIndex] === ">>" ? (fileContent(target) ?? "") : "";
            workdir[target] = base ? `${base}\n${text}` : text;
            print(`wrote ${target} (not staged yet, run: git add ${target})`, "text-slate-500");
        } else if (cmd === "ls") {
            const names = new Set([...Object.keys(state.working_tree), ...Object.keys(state.staging_area), ...Object.keys(workdir)]);
            print(names.size ? [...names].sort().join("  ") : "(empty)", names.size ? "text-sky-300" : "text-slate-500");
        } else if (cmd === "cat") {
            if (!args[0]) return print("usage: cat <file>", "text-rose-300");
            const content = fileContent(args[0]);
            content === undefined ? print(`cat: ${args[0]}: No such file`, "text-rose-300") : print(content);
        } else {
            print(`${cmd}: command not found. Type 'help'.`, "text-rose-300");
        }
    }

    $("terminalForm").addEventListener("submit", async e => {
        e.preventDefault();
        const line = termInput.value.trim();
        termInput.value = "";
        if (!line) return;
        termHistory.push(line);
        historyIndex = termHistory.length;
        print(`${state.current_branch} $ ${line}`, "text-slate-100");
        termInput.disabled = true;
        try {
            await runCommand(line);
        } finally {
            termInput.disabled = false;
            termInput.focus();
        }
    });

    termInput.addEventListener("keydown", e => {
        if (e.key === "ArrowUp" && historyIndex > 0) {
            historyIndex--;
        } else if (e.key === "ArrowDown" && historyIndex < termHistory.length) {
            historyIndex++;
        } else {
            return;
        }
        e.preventDefault();
        termInput.value = termHistory[historyIndex] ?? "";
    });

    term.addEventListener("click", () => termInput.focus());

    clearTerminal();
    fetchState();
});
