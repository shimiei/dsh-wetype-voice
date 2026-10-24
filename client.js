window.__ModuleLoader__.load({
	id: "dsh-wetype-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const h = react.createElement;
		const { useCallback, useEffect, useRef, useState } = react;

		const name = "dsh-wetype-voice";
		const inject = ["slots"];
		const SLOT = "conversation.input.activity";
		const ENDPOINT = "/wetype/api";

		/** POST one operation to the host half; never throws. */
		async function callHost(payload, timeoutMs) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
			try {
				const response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					cache: "no-store",
					body: JSON.stringify(payload),
					signal: controller.signal,
				});
				const text = await response.text();
				let data;
				try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 200) }; }
				return data;
			} catch (error) {
				return { ok: false, error: error && error.name === "AbortError" ? "宿主响应超时" : String(error && error.message ? error.message : error) };
			} finally {
				clearTimeout(timer);
			}
		}

		/** Keep dictation text landing in the composer even if the button stole focus. */
		function ensureComposerFocus() {
			try {
				const active = document.activeElement;
				const inside = active && typeof active.closest === "function" && active.closest('[contenteditable="true"]');
				if (inside) return;
				const editable = document.querySelector('[data-lexical-editor="true"], [contenteditable="true"]');
				if (!editable) return;
				editable.focus({ preventScroll: true });
				const selection = window.getSelection();
				if (selection && editable.childNodes.length >= 0) {
					const range = document.createRange();
					range.selectNodeContents(editable);
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				}
			} catch { /* focusing is best effort */ }
		}

		const MIC_PATH = "M12 3.5a3.2 3.2 0 0 0-3.2 3.2v5a3.2 3.2 0 0 0 6.4 0v-5A3.2 3.2 0 0 0 12 3.5Z";

		function MicIcon() {
			return h("svg", {
				width: 18,
				height: 18,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			}, [
				h("path", { key: "capsule", d: MIC_PATH }),
				h("path", { key: "arc", d: "M6.4 11.2v.9a5.6 5.6 0 0 0 11.2 0v-.9" }),
				h("path", { key: "stem", d: "M12 17.7V20" }),
			]);
		}

		function Spinner() {
			return h("span", {
				style: {
					width: 14,
					height: 14,
					borderRadius: "50%",
					border: "1.6px solid currentColor",
					borderTopColor: "transparent",
					animation: "dsh-wetype-spin .7s linear infinite",
					display: "inline-block",
				},
			});
		}

		/**
		 * Microphone entry that hands dictation to the WeChat Input Method.
		 * Recording, cloud recognition and insertion are entirely WeType's; this
		 * component only presses its hotkey and reports what happened.
		 */
		function WeTypeVoiceButton(props) {
			const locked = props && props.locked === true;
			const [phase, setPhase] = useState("idle");
			const [message, setMessage] = useState("");
			const [hover, setHover] = useState(false);
			const mounted = useRef(true);
			const pollTimer = useRef(undefined);

			useEffect(() => () => {
				mounted.current = false;
				if (pollTimer.current) clearTimeout(pollTimer.current);
			}, []);

			const stopPolling = useCallback(() => {
				if (pollTimer.current) clearTimeout(pollTimer.current);
				pollTimer.current = undefined;
			}, []);

			// While WeType's dictation surface is on screen the button keeps the
			// listening look; it falls back to idle the moment that surface is
			// gone (WeType also auto-finishes after a pause in speech).
			const watch = useCallback((attempt) => {
				if (pollTimer.current) clearTimeout(pollTimer.current);
				pollTimer.current = setTimeout(async () => {
					if (!mounted.current) return;
					const state = await callHost({ op: "state" }, 4000);
					if (!mounted.current) return;
					if (state && state.ok && state.listening) {
						if (attempt < 60) watch(attempt + 1);
						return;
					}
					if (attempt < 3) {
						watch(attempt + 1);
						return;
					}
					setPhase("idle");
					setMessage("");
				}, attempt === 0 ? 260 : 700);
			}, []);

			useEffect(() => () => stopPolling(), [stopPolling]);

			// A failure stays readable in the tooltip for a few seconds, then the
			// button goes back to its neutral look so it never looks stuck.
			useEffect(() => {
				if (phase !== "error") return undefined;
				const timer = setTimeout(() => {
					if (mounted.current) {
						setPhase("idle");
						setMessage("");
					}
				}, 6000);
				return () => clearTimeout(timer);
			}, [phase]);

			const trigger = useCallback(async () => {
				if (locked) return;
				setHover(true);
				ensureComposerFocus();
				const wasListening = phase === "listening";
				setPhase("sending");
				setMessage("");
				const result = await callHost({ op: "trigger" }, 8000);
				if (!mounted.current) return;
				if (result && result.ok) {
					if (wasListening) {
						stopPolling();
						setPhase("idle");
						setMessage("");
						return;
					}
					setPhase("listening");
					setMessage("微信输入法正在听，说完再点一次结束");
					watch(0);
					return;
				}
				setPhase("error");
				setMessage(`微信输入法语音输入未触发：${(result && (result.detail || result.error)) || "未知原因"}`);
			}, [locked, phase, stopPolling, watch]);

			const label = phase === "error" || phase === "listening" || phase === "sent" ? message : "语音输入（微信输入法）";
			const color = phase === "error"
				? "var(--dsh-color-danger, #e5484d)"
				: phase === "listening" || phase === "sent"
					? "var(--dsh-color-accent, #4d6bfe)"
					: "inherit";

			const style = {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 30,
				height: 30,
				padding: 0,
				margin: 0,
				border: "none",
				borderRadius: 8,
				background: hover && !locked ? "rgba(127,127,127,.14)" : "transparent",
				color,
				opacity: locked ? 0.45 : 1,
				cursor: locked ? "default" : "pointer",
				transition: "background .15s ease",
				WebkitAppearance: "none",
			};

			return h("span", {
				style: { display: "inline-flex", alignItems: "center" },
				title: label,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
			}, [
				h("button", {
					key: "mic",
					type: "button",
					"aria-label": "语音输入（微信输入法）",
					"data-wetype-voice": phase,
					disabled: locked,
					style,
					onMouseDown: (event) => {
						event.preventDefault();
						setHover(true);
					},
					onClick: trigger,
				}, phase === "sending" ? h(Spinner) : h(MicIcon)),
			]);
		}

		const SPIN_KEYFRAMES = "dsh-wetype-spin";

		function ensureSpinnerStyle() {
			try {
				if (document.getElementById("dsh-wetype-style")) return;
				const node = document.createElement("style");
				node.id = "dsh-wetype-style";
				node.textContent = `@keyframes ${SPIN_KEYFRAMES}{to{transform:rotate(360deg)}}`;
				document.head.appendChild(node);
			} catch { /* styling is best effort */ }
		}

		// ---------------------------------------------------------------------
		// Plugin panel configuration page (插件 → 已安装 → 本组合包 → 配置)
		// ---------------------------------------------------------------------
		const CONFIG_SLOT = "plugins.row.config";
		const CONFIG_KEY = "dsh-wetype-voice#wetype-voice";

		const CODE_TO_KEY = {
			Backquote: "`",
			Minus: "-",
			Equal: "=",
			BracketLeft: "[",
			BracketRight: "]",
			Backslash: "\\",
			Semicolon: ";",
			Quote: "'",
			Comma: ",",
			Period: ".",
			Slash: "/",
		};

		/** Map a KeyboardEvent to the key name the host's scancode table uses. */
		function mainKeyOf(event) {
			const code = typeof event.code === "string" ? event.code : "";
			if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
			if (/^Digit\d$/.test(code)) return code.slice(5);
			if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
			if (code === "Space") return "space";
			if (code === "Enter" || code === "NumpadEnter") return "enter";
			if (code === "Escape") return "esc";
			if (code === "Tab") return "tab";
			if (code === "Backspace") return "backspace";
			if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
			return null;
		}

		const SPLIT_LIST = (value) => String(value || "")
			.split(/[,;\s]+/)
			.map((item) => item.trim())
			.filter((item) => item !== "");

		const FIELD_STYLE = {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginBottom: 14,
		};
		const LABEL_STYLE = {
			fontSize: 12,
			fontWeight: 600,
			color: "var(--dsh-color-text-secondary, #666)",
		};
		const INPUT_STYLE = {
			width: "100%",
			boxSizing: "border-box",
			padding: "7px 10px",
			fontSize: 13,
			fontFamily: "inherit",
			color: "inherit",
			background: "var(--dsh-color-surface, rgba(127,127,127,.06))",
			border: "1px solid var(--dsh-color-border, rgba(127,127,127,.25))",
			borderRadius: 8,
			outline: "none",
		};
		const HINT_STYLE = { fontSize: 11, lineHeight: 1.5, color: "var(--dsh-color-text-tertiary, #888)" };
		const BUTTON_STYLE = {
			padding: "6px 12px",
			fontSize: 12,
			fontFamily: "inherit",
			borderRadius: 8,
			border: "1px solid var(--dsh-color-border, rgba(127,127,127,.25))",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};
		const PRIMARY_BUTTON_STYLE = {
			...BUTTON_STYLE,
			border: "1px solid transparent",
			background: "var(--dsh-color-accent, #4d6bfe)",
			color: "#fff",
			fontWeight: 600,
		};

		function Note(props) {
			const note = props.note;
			if (!note) return null;
			const color = note.kind === "error"
				? "var(--dsh-color-danger, #e5484d)"
				: note.kind === "warn"
					? "var(--dsh-color-warning, #d97706)"
					: "var(--dsh-color-success, #12805c)";
			return h("div", {
				style: { fontSize: 12, lineHeight: 1.6, marginBottom: 12, color },
				role: note.kind === "error" ? "alert" : "status",
			}, note.text);
		}

		/**
		 * Config form for the plugin panel: hotkey capture, injection mode, process
		 * guard, lead delay, plus "test" and "detect my WeType hotkey" actions.
		 */
		function WeTypeConfigForm(props) {
			const view = props && props.view;
			const [loaded, setLoaded] = useState(false);
			const [version, setVersion] = useState("");
			const [draft, setDraft] = useState({ hotkey: "ralt+space", injectMode: "scan", guard: "auto", allowProcesses: "", leadMs: 60 });
			const [busy, setBusy] = useState("");
			const [note, setNote] = useState(null);
			const [capturing, setCapturing] = useState(false);
			const sides = useRef({ ctrl: "ctrl", alt: "alt", shift: "shift", meta: "win" });
			const mounted = useRef(true);

			useEffect(() => () => { mounted.current = false; }, []);

			const applyStatus = useCallback((status) => {
				if (!status || status.ok !== true) return;
				setLoaded(true);
				setVersion(status.weType && status.weType.version ? status.weType.version : "");
				setDraft({
					hotkey: status.hotkey || "ralt+space",
					injectMode: status.injectMode || "scan",
					guard: status.guard || "auto",
					allowProcesses: Array.isArray(status.allowProcesses) ? status.allowProcesses.join(", ") : "",
					leadMs: typeof status.leadMs === "number" ? status.leadMs : 60,
				});
			}, []);

			const load = useCallback(async () => {
				applyStatus(await callHost({ op: "status" }, 6000));
			}, [applyStatus]);

			useEffect(() => { load(); }, [load]);

			// Capture phase on window so the browser's own shortcut does not fire.
			useEffect(() => {
				if (!capturing) return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						setCapturing(false);
						return undefined;
					}
					if (event.key === "Alt" || event.key === "Control" || event.key === "Shift" || event.key === "Meta") {
						const side = event.location === 2 ? "r" : "l";
						if (event.key === "Alt") sides.current.alt = side === "r" ? "ralt" : "lalt";
						if (event.key === "Control") sides.current.ctrl = side === "r" ? "rctrl" : "lctrl";
						if (event.key === "Shift") sides.current.shift = side === "r" ? "rshift" : "lshift";
						if (event.key === "Meta") sides.current.meta = side === "r" ? "rwin" : "lwin";
						event.preventDefault();
						return undefined;
					}
					const main = mainKeyOf(event);
					if (!main) {
						event.preventDefault();
						setNote({ kind: "warn", text: `这个键（${event.code || event.key}）不在可注入的键表里，换一个` });
						return undefined;
					}
					event.preventDefault();
					event.stopPropagation();
					const parts = [];
					if (event.ctrlKey) parts.push(sides.current.ctrl);
					if (event.altKey) parts.push(sides.current.alt);
					if (event.shiftKey) parts.push(sides.current.shift);
					if (event.metaKey) parts.push(sides.current.meta);
					if (parts.length === 0) {
						setNote({ kind: "warn", text: "微信输入法只接受带修饰键的组合，按住 Ctrl / Alt / Shift / Win 再按主键" });
						return undefined;
					}
					const spec = parts.concat(main).join("+");
					setDraft((current) => ({ ...current, hotkey: spec }));
					setCapturing(false);
					setNote({ kind: "ok", text: `已录入 ${spec} —— 点「保存」才生效` });
					return undefined;
				};
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, [capturing]);

			const save = useCallback(async () => {
				setBusy("save");
				const result = await callHost({
					op: "save",
					hotkey: draft.hotkey,
					injectMode: draft.injectMode,
					guard: draft.guard,
					allowProcesses: SPLIT_LIST(draft.allowProcesses),
					leadMs: Number(draft.leadMs) || 0,
				}, 8000);
				if (!mounted.current) return;
				setBusy("");
				if (result && result.ok) {
					applyStatus({ ...result.settings, ok: true, weType: { version } });
					setNote({ kind: "ok", text: "已保存，下一次点麦克风就按新配置发键" });
					return;
				}
				setNote({ kind: "error", text: `保存失败：${(result && (result.error || result.detail)) || "未知原因"}` });
			}, [applyStatus, draft, version]);

			const detect = useCallback(async () => {
				setBusy("detect");
				setNote({ kind: "ok", text: "正在逐个试候选快捷键，别动键盘…" });
				const result = await callHost({ op: "detect", persist: true }, 60000);
				if (!mounted.current) return;
				setBusy("");
				if (result && result.ok) {
					setDraft((current) => ({ ...current, hotkey: result.hotkey }));
					setNote({ kind: "ok", text: `探测到微信输入法的语音快捷键是 ${result.hotkey}，已保存` });
					return;
				}
				const tried = result && Array.isArray(result.tried)
					? result.tried.map((item) => `${item.hotkey}:${item.result === "miss" ? "没反应" : item.result}`).join("，")
					: "";
				setNote({
					kind: "error",
					text: `没试出来。${(result && (result.detail || result.error)) || ""}${result && result.tried && result.tried[0] && result.tried[0].result === "SKIP" ? "（前台不是 DSH 窗口，先把 DSH 切到前台）" : ""}${tried ? ` 试过：${tried}` : ""}`,
				});
			}, []);

			const test = useCallback(async () => {
				setBusy("test");
				const result = await callHost({ op: "trigger" }, 12000);
				if (!mounted.current) return;
				setBusy("");
				if (result && result.ok) {
					setNote({ kind: "ok", text: `已发送 ${draft.hotkey}，看微信输入法有没有弹出语音条` });
					return;
				}
				setNote({ kind: "error", text: `发送失败：${(result && (result.detail || result.error)) || "未知原因"}` });
			}, [draft.hotkey]);

			if (view === "summary") {
				return h("span", { style: HINT_STYLE }, "微信输入法语音：热键 / 注入方式 / 守卫");
			}

			const field = (key, label, control, hint) => h("div", { key, style: FIELD_STYLE }, [
				h("label", { key: "label", style: LABEL_STYLE }, label),
				control,
				hint ? h("span", { key: "hint", style: HINT_STYLE }, hint) : null,
			]);

			const onChange = (key) => (event) => {
				const value = event.target.value;
				setDraft((current) => ({ ...current, [key]: value }));
			};

			return h("div", { style: { display: "flex", flexDirection: "column" }, "data-wetype-config": "page" }, [
				h("div", { key: "head", style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 } }, [
					h("strong", { key: "t", style: { fontSize: 13 } }, "微信输入法语音"),
					h("span", { key: "v", style: HINT_STYLE }, version ? `微信输入法 ${version}` : "未检测到微信输入法"),
				]),

				field(
					"hotkey",
					"语音快捷键",
					h("div", { key: "hotkey-row", style: { display: "flex", gap: 8 } }, [
						h("input", {
							key: "input",
							style: { ...INPUT_STYLE, flex: 1, fontFamily: "ui-monospace, monospace" },
							value: draft.hotkey,
							onChange: onChange("hotkey"),
							spellCheck: false,
							"aria-label": "语音快捷键",
						}),
						h("button", {
							key: "capture",
							type: "button",
							style: capturing ? { ...BUTTON_STYLE, color: "var(--dsh-color-accent, #4d6bfe)", borderColor: "currentColor" } : BUTTON_STYLE,
							onClick: () => { setNote(null); setCapturing((value) => !value); },
						}, capturing ? "按下组合键…（Esc 取消）" : "录入"),
					]),
					"要和微信输入法「启动语音输入」完全一致。不确定就点下面的「自动探测」。",
				),

				field(
					"mode",
					"注入方式",
					h("select", { key: "mode", style: INPUT_STYLE, value: draft.injectMode, onChange: onChange("injectMode"), "aria-label": "注入方式" }, [
						h("option", { key: "scan", value: "scan" }, "scan（扫描码，默认，最接近物理按键）"),
						h("option", { key: "vk", value: "vk" }, "vk（虚拟键码）"),
						h("option", { key: "both", value: "both" }, "both（两种都发一次）"),
					]),
					"scan 能区分左右修饰键，微信输入法认这个；识别不到时再试 vk。",
				),

				field(
					"guard",
					"前台守卫",
					h("select", { key: "guard", style: INPUT_STYLE, value: draft.guard, onChange: onChange("guard"), "aria-label": "前台守卫" }, [
						h("option", { key: "auto", value: "auto" }, "auto（只在本应用窗口前台时发键）"),
						h("option", { key: "list", value: "list" }, "list（只允许下面列出的进程）"),
						h("option", { key: "any", value: "any" }, "any（不检查）"),
					]),
					"防止把语音快捷键打进别的窗口。",
				),

				field(
					"allow",
					"允许的进程（guard = list 时生效）",
					h("input", {
						key: "allow",
						style: INPUT_STYLE,
						value: draft.allowProcesses,
						onChange: onChange("allowProcesses"),
						placeholder: "chrome.exe, msedge.exe",
						spellCheck: false,
						"aria-label": "允许的进程",
					}),
					"用浏览器打开 DSH Web 时可以填浏览器进程名，逗号分隔。",
				),

				field(
					"lead",
					"预热延时（毫秒）",
					h("input", {
						key: "lead",
						style: { ...INPUT_STYLE, maxWidth: 120 },
						type: "number",
						min: 0,
						max: 2000,
						value: draft.leadMs,
						onChange: onChange("leadMs"),
						"aria-label": "预热延时",
					}),
					"按键前等一小会儿，给焦点切换留时间，默认 60。",
				),

				h(Note, { key: "note", note }),

				h("div", { key: "actions", style: { display: "flex", gap: 8, flexWrap: "wrap" } }, [
					h("button", {
						key: "save",
						type: "button",
						style: busy ? { ...PRIMARY_BUTTON_STYLE, opacity: 0.6 } : PRIMARY_BUTTON_STYLE,
						disabled: busy !== "",
						onClick: save,
					}, busy === "save" ? "保存中…" : "保存"),
					h("button", {
						key: "detect",
						type: "button",
						style: BUTTON_STYLE,
						disabled: busy !== "",
						onClick: detect,
					}, busy === "detect" ? "探测中…" : "自动探测快捷键"),
					h("button", {
						key: "test",
						type: "button",
						style: BUTTON_STYLE,
						disabled: busy !== "",
						onClick: test,
					}, busy === "test" ? "发送中…" : "试一次"),
					h("button", {
						key: "reset",
						type: "button",
						style: BUTTON_STYLE,
						disabled: busy !== "",
						onClick: () => {
							setDraft({ hotkey: "ralt+space", injectMode: "scan", guard: "auto", allowProcesses: "", leadMs: 60 });
							setNote({ kind: "ok", text: "已恢复默认值 —— 点「保存」才生效" });
						},
					}, "恢复默认"),
				]),

				loaded
					? null
					: h("div", { key: "loading", style: { ...HINT_STYLE, marginTop: 10 } }, "读取配置中…"),
			]);
		}

		function apply(ctx) {
			ensureSpinnerStyle();
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register({
					name: SLOT,
					id: "dsh-wetype-voice",
					order: 40,
				}, WeTypeVoiceButton));
			} catch (error) {
				console.warn("[dsh-wetype-voice] slot registration skipped:", error);
			}
			// Config page lives in the plugin panel; it only exists when the plugin
			// manager declares the slot, so a missing slot must not break the button.
			try {
				ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register({
					name: CONFIG_SLOT,
					key: CONFIG_KEY,
				}, WeTypeConfigForm));
			} catch (error) {
				console.warn("[dsh-wetype-voice] config page registration skipped:", error);
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.SLOT = SLOT;
		exports.CONFIG_SLOT = CONFIG_SLOT;
		exports.CONFIG_KEY = CONFIG_KEY;
		exports.WeTypeConfigForm = WeTypeConfigForm;
		exports.ENDPOINT = ENDPOINT;
		exports.apply = apply;
		return module.exports;
	}
});
