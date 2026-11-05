"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { Avatar } from "@/components/ui/primitives";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { StoryAppearanceVariables } from "./story-appearance-variables";
import { copyStoryAppearancePrefs, deleteStoryAppearancePreset, getStoryAppearancePresets, renameStoryAppearancePreset, saveStoryAppearancePreset } from "@/lib/story-appearance-presets";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { isStoryBasicAppearanceEnabled, isStoryReadingPanelVisible, storyStageAppearanceClass, normalizeStoryChromeAppearance, storyChromeAttributes, storyMessageAppearanceAttributes, normalizeStoryBubbleAppearance, normalizeStoryMessageGap, STORY_THEMES,
  type StoryAppearance, type StoryAppearancePrefs, type StoryBubbleAppearance } from "@/lib/story-appearance";

import { loadStoryAppearanceEditorState, saveStoryAppearanceEditorState, type StoryAppearanceEditorState } from "@/lib/story-appearance-editor-state";

function RangeSetting({ label, value, min, max, step = 1, unit = "", onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void;
}) {
  const id = useId();
  const touch = useRef<{ x: number; y: number; direction: "pending" | "horizontal" | "scroll"; value?: number } | null>(null);
  return <div className="story-beautify-range"><label htmlFor={id}>{label}<output>{value}{unit}</output></label>
    <input id={id} aria-label={label} type="range" min={min} max={max} step={step} value={value}
      onPointerDown={event => { if (event.pointerType !== "touch") touch.current = null; }}
      onKeyDown={() => { touch.current = null; }}
      onTouchStart={event => {
        const point = event.touches[0];
        if (point) touch.current = { x: point.clientX, y: point.clientY, direction: "pending" };
      }}
      onTouchMove={event => {
        const gesture = touch.current, point = event.touches[0];
        if (!gesture || !point || gesture.direction !== "pending") return;
        const dx = Math.abs(point.clientX - gesture.x), dy = Math.abs(point.clientY - gesture.y);
        if (Math.max(dx, dy) < 8) return;
        gesture.direction = dy >= dx ? "scroll" : "horizontal";
        if (gesture.direction === "horizontal" && gesture.value !== undefined) onChange(gesture.value);
      }}
      onTouchEnd={() => {
        const gesture = touch.current;
        if (gesture?.direction === "pending" && gesture.value !== undefined) onChange(gesture.value);
        // Keep cancelled gestures blocked until the next intentional input; some browsers dispatch a late change.
        if (gesture?.direction !== "scroll") touch.current = null;
      }}
      onTouchCancel={() => { if (touch.current) touch.current.direction = "scroll"; }}
      onChange={event => {
        const next = Number(event.target.value), gesture = touch.current;
        if (gesture && gesture.direction !== "horizontal") {
          if (gesture.direction === "pending") gesture.value = next;
          return;
        }
        onChange(next);
      }} />
  </div>;
}

export function StoryAppearanceEditor({ sessionId, initialPrefs, initialCSS, customFont, userName, characterName, userAvatar, characterAvatar, onSettingsChange, onCSSChange, onApplyAppearance, onClose }: {
  sessionId: string; initialPrefs: StoryAppearancePrefs; initialCSS: string; userName: string; characterName: string; userAvatar?: string; characterAvatar?: string;
  customFont?: string;
  onSettingsChange: (patch: Omit<StoryAppearancePrefs, "appearance">) => void; onCSSChange: (css: string) => void;
  onApplyAppearance: (appearance: StoryAppearance | undefined) => void; onClose: () => void;
}) {
  const [initialEditorState] = useState(() => loadStoryAppearanceEditorState(sessionId, initialPrefs.appearance));
  // Keep editable controls outside the session CSS scope, so even broad custom rules cannot hide them.
  const [portalHost] = useState(() => typeof document === "undefined" ? null : document.querySelector(".phone-shell") || document.body);
  const previewId = `story-beautify-preview-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const previewScope = `.${previewId}`;
  const [prefs, setPrefs] = useState<StoryAppearancePrefs>(() => ({ theme: initialPrefs.theme, wallpaper: initialPrefs.wallpaper,
    appearanceMode: initialPrefs.appearanceMode, readingPanel: initialPrefs.readingPanel, chrome: initialPrefs.chrome, appearance: initialEditorState.draft ? initialEditorState.draft.appearance : initialPrefs.appearance }));
  const [css, setCSS] = useState(initialCSS);
  const [role, setRole] = useState(initialEditorState.role);
  const [barsOpen, setBarsOpen] = useState(initialEditorState.barsOpen);
  const [cssOpen, setCSSOpen] = useState(initialEditorState.cssOpen);
  const [notice, setNotice] = useState("");
  const [wallpaperLoading, setWallpaperLoading] = useState(false);
  const [presets, setPresets] = useState(getStoryAppearancePresets);
  const [selectedPresetId, setSelectedPresetId] = useState(initialEditorState.selectedPresetId || "");
  const [presetName, setPresetName] = useState(() => getStoryAppearancePresets().find(item => item.id === initialEditorState.selectedPresetId)?.name || "");
  const [deletePending, setDeletePending] = useState(false);
  const selectedPreset = presets.find(item => item.id === selectedPresetId);
  const fileRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const appliedAppearanceRef = useRef(initialPrefs.appearance);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressRef = useRef<StoryAppearanceEditorState>(initialEditorState);
  progressRef.current = { role, barsOpen, cssOpen, selectedPresetId, scrollTop: progressRef.current.scrollTop,
    draft: JSON.stringify(prefs.appearance) === JSON.stringify(appliedAppearanceRef.current) ? undefined
      : { appearance: prefs.appearance, baseAppearance: appliedAppearanceRef.current } };
  const saveProgress = useCallback(() => {
    saveStoryAppearanceEditorState(sessionId, { ...progressRef.current, scrollTop: mainRef.current?.scrollTop ?? progressRef.current.scrollTop });
  }, [sessionId]);
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = initialEditorState.scrollTop;
    return () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); saveProgress(); };
  }, [initialEditorState.scrollTop, saveProgress]);
  useEffect(() => { saveProgress(); }, [role, barsOpen, cssOpen, selectedPresetId, prefs.appearance, saveProgress]);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRequest = useRef(0);
  const [palette, setPalette] = useState({ backgroundColor: "#ffffff", textColor: "#334155", dialogueColor: "#334155", boldColor: "#1e293b", italicColor: "#334155" });
  const panelVisible = isStoryReadingPanelVisible(prefs);
  const basicEnabled = isStoryBasicAppearanceEnabled(prefs);
  const displayRole = role === "both" ? "user" : role;
  const chrome = normalizeStoryChromeAppearance(prefs.chrome);
  const appearance = normalizeStoryBubbleAppearance(prefs.appearance?.[displayRole]);
  const patch = (next: Partial<StoryBubbleAppearance>) => {
    setNotice("");
    setPrefs(previous => {
      const updated = { ...previous.appearance };
      for (const target of role === "both" ? ["user", "assistant"] as const : [role]) {
        updated[target] = { ...updated[target], ...next };
      }
      return { ...previous, appearance: updated };
    });
  };
  const applySettings = (next: Omit<StoryAppearancePrefs, "appearance">) => {
    setPrefs(previous => ({ ...previous, ...next }));
    onSettingsChange(next);
  };
  const patchChrome = (next: Partial<NonNullable<StoryAppearancePrefs["chrome"]>>) => applySettings({ chrome: { ...prefs.chrome, ...next } });
  const applyCSS = (next: string) => { setCSS(next); onCSSChange(next); };
  const savePreset = (update = false) => {
    const saved = saveStoryAppearancePreset(presetName, prefs, css, update ? selectedPresetId : undefined);
    if (!saved) { setNotice("请填写预设名称，并选择有效的预设。"); return; }
    setPresets(getStoryAppearancePresets()); setSelectedPresetId(saved.id); setPresetName(saved.name); setDeletePending(false);
    setNotice(update ? "预设已更新为当前参数。" : "当前参数已保存为预设，可在其他剧情中选择应用。");
  };
  const applyPreset = () => {
    const saved = getStoryAppearancePresets().find(item => item.id === selectedPresetId);
    if (!saved) { setNotice("该预设已不存在，请重新选择。"); setPresets(getStoryAppearancePresets()); return; }
    const next = copyStoryAppearancePrefs(saved.prefs);
    fileRequest.current++; setWallpaperLoading(false);
    setPrefs(next); applyCSS(saved.css);
    const { appearance: nextAppearance, ...settings } = next;
    onSettingsChange(settings); onApplyAppearance(nextAppearance);
    appliedAppearanceRef.current = nextAppearance; progressRef.current.draft = undefined;
    saveProgress(); setPresetName(saved.name); setDeletePending(false); setNotice(`已应用预设「${saved.name}」，可继续调整。`);
  };

  useEffect(() => () => { fileRequest.current++; }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!rootRef.current) return;
      const style = getComputedStyle(rootRef.current);
      const get = (key: string, fallback: string) => {
        const value = style.getPropertyValue(key).trim();
        return /^#[\da-f]{6}$/i.test(value) ? value : fallback;
      };
      const text = get(displayRole === "user" ? "--c-story-text-user" : "--c-story-text", get("--c-story-text", "#334155"));
      setPalette({ backgroundColor: get(displayRole === "user" ? "--c-story-bubble-user" : "--c-story-bubble-bg", "#ffffff"),
        textColor: text, dialogueColor: text, italicColor: text, boldColor: get("--c-story-heading", "#1e293b") });
    });
    return () => cancelAnimationFrame(frame);
  }, [prefs.theme, displayRole]);

  const chooseWallpaper = (file?: File) => {
    if (!file) return;
    const request = ++fileRequest.current;
    setWallpaperLoading(true);
    const reader = new FileReader();
    reader.onload = () => { if (request === fileRequest.current && typeof reader.result === "string") {
      applySettings({ wallpaper: reader.result as string }); setNotice(""); setWallpaperLoading(false);
    } };
    reader.onerror = () => { if (request === fileRequest.current) { setNotice("壁纸读取失败，请重新选择图片"); setWallpaperLoading(false); } };
    reader.readAsDataURL(file);
  };

  const colorSetting = (key: "backgroundColor" | "textColor" | "dialogueColor" | "boldColor" | "italicColor", label: string) => <div className="story-beautify-color" key={key}>
    <label><span>{label}</span><input type="color" aria-label={label} value={appearance[key] || palette[key]} onChange={event => patch({ [key]: event.target.value })} /></label>
    {(appearance[key] || (role === "both" && prefs.appearance?.assistant?.[key])) ? <button type="button" onClick={() => patch({ [key]: undefined })}>跟随主题</button> : <small>跟随主题</small>}
  </div>;

  const editor = <div ref={rootRef} className="story-beautify-page" data-story-theme={prefs.theme || "paper"}
    style={customFont ? { "--story-font": customFont } as CSSProperties : undefined} role="dialog" aria-modal="true" aria-label="剧情美化"
    onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onMouseMove={event => event.stopPropagation()}>
    <header><strong>剧情美化</strong><button type="button" onClick={() => { saveProgress(); onClose(); }} aria-label="关闭美化"><XMarkIcon width={20} /></button></header>
    <main ref={mainRef} onScroll={event => {
      progressRef.current.scrollTop = event.currentTarget.scrollTop;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(saveProgress, 180);
    }}>
      <section className="story-beautify-card">
        <h3>背景壁纸</h3>
        {prefs.wallpaper ? <img className="story-beautify-wallpaper" src={prefs.wallpaper} alt="当前剧情壁纸" /> : <p>未设置壁纸</p>}
        <div className="story-beautify-actions"><button type="button" onClick={() => fileRef.current?.click()}>选择壁纸</button>
          {prefs.wallpaper && <button type="button" onClick={() => { fileRequest.current++; setWallpaperLoading(false); applySettings({ wallpaper: undefined }); }}>清除壁纸</button>}</div>
        <input ref={fileRef} hidden type="file" accept="image/*" onChange={event => { chooseWallpaper(event.target.files?.[0]); event.target.value = ""; }} />
      </section>

      <section className="story-beautify-card">
        <h3>阅读面板</h3>
        <div className="story-beautify-tabs" role="group" aria-label="阅读面板">
          {([{ id: "auto", name: "自动" }, { id: "show", name: "保留" }, { id: "hide", name: "去掉" }] as const).map(option =>
            <button key={option.id} type="button" aria-pressed={(prefs.readingPanel || "auto") === option.id} onClick={() => applySettings({ readingPanel: option.id })}>{option.name}</button>)}
        </div>
        <p>{(prefs.readingPanel || "auto") === "auto" ? "自动：有壁纸时直接展示背景，没有壁纸时保留原阅读面板。" : panelVisible ? "保留原来的整块阅读面板。" : "去掉整块阅读面板与壁纸遮罩，自定义用户和角色样式。"}</p>
      </section>

      <label className="story-beautify-preset"><span>主题预设</span><select aria-label="主题预设" value={prefs.theme || "paper"} onChange={event => applySettings({ theme: event.target.value })}>
        {STORY_THEMES.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
      </select></label>

      <section className="story-beautify-card">
        <h3>美化方式</h3>
        <label className="story-beautify-preset"><span>样式来源</span><select aria-label="美化方式" value={prefs.appearanceMode || "combined"} onChange={event => applySettings({ appearanceMode: event.target.value === "css-only" ? "css-only" : "combined" })}>
          <option value="combined">基础美化＋高级 CSS</option><option value="css-only">仅使用高级 CSS</option>
        </select></label>
        <p>{basicEnabled ? "高级 CSS 覆盖写到的部分，其余沿用基础美化。" : "基础拉杆、颜色、位置及两栏参数已暂停，原数值保留。CSS 未写到的部分沿用页面默认样式；壁纸、主题与阅读面板仍可单独设置。"}</p>
      </section>

      {basicEnabled && <details className="story-beautify-card story-beautify-bars" open={barsOpen} onToggle={event => setBarsOpen(event.currentTarget.open)}><summary>顶栏、底栏与按钮</summary>
        <p>两栏共用背景透明度与文字、图标颜色。按钮透明度只改变背景小方块，设置后立即保存应用。</p>
        <RangeSetting label="顶栏与底栏背景透明度" value={100 - chrome.barOpacity} min={0} max={100} unit="％" onChange={value => patchChrome({ barOpacity: 100 - value })} />
        <RangeSetting label="两栏按钮背景透明度" value={100 - chrome.buttonOpacity} min={0} max={100} unit="％" onChange={value => patchChrome({ buttonOpacity: 100 - value })} />
        <div className="story-beautify-color"><label><span>两栏文字与图标颜色</span><input type="color" aria-label="两栏文字与图标颜色" value={chrome.controlsColor || palette.textColor} onChange={event => patchChrome({ controlsColor: event.target.value })} /></label>
          {chrome.controlsColor ? <button type="button" onClick={() => patchChrome({ controlsColor: undefined })}>跟随主题</button> : <small>跟随主题</small>}</div>
        <label className="story-beautify-check"><input type="checkbox" aria-label="显示顶栏头像" checked={!chrome.hideHeaderAvatar} onChange={event => patchChrome({ hideHeaderAvatar: !event.target.checked })} /><span>显示左上角角色头像</span></label>
        <button type="button" className="story-beautify-reset-side" onClick={() => applySettings({ chrome: undefined })}>恢复两栏默认设置</button>
      </details>}

      {!panelVisible && basicEnabled && <section className="story-beautify-card">
        <h3>基础美化</h3>
        <div className="story-beautify-tabs" role="group" aria-label="美化对象">
          <button type="button" aria-pressed={role === "user"} onClick={() => setRole("user")}>用户</button>
          <button type="button" aria-pressed={role === "assistant"} onClick={() => setRole("assistant")}>角色</button>
          <button type="button" aria-pressed={role === "both"} onClick={() => setRole("both")}>一起设置</button>
        </div>
        <p>{role === "both" ? "以用户当前数值显示，修改的项目同时应用双方，其余项目保留各自设置。" : "基础美化会保留编辑进度，保存并应用后生效。"}</p>
        <h4>气泡</h4>
        <label className="story-beautify-preset"><span>气泡位置</span><select aria-label="气泡位置" value={appearance.bubblePosition} onChange={event => patch({ bubblePosition: event.target.value as StoryBubbleAppearance["bubblePosition"] })}>
          <option value="left">靠左</option><option value="center">居中（左右留白一致）</option><option value="right">靠右</option>
        </select></label>
        <p>独立控制气泡位置；头像位置单独设置，正文保持正常排版。</p>
        {colorSetting("backgroundColor", "背景颜色")}
        <RangeSetting label="背景透明度" value={100 - appearance.backgroundOpacity} min={0} max={100} unit="％" onChange={value => patch({ backgroundOpacity: 100 - value })} />
        <RangeSetting label="内边距" value={appearance.padding} min={0} max={32} unit="px" onChange={value => patch({ padding: value })} />
        <RangeSetting label="气泡圆角" value={appearance.radius} min={0} max={40} unit="px" onChange={value => patch({ radius: value })} />
        <RangeSetting label="气泡最大宽度" value={appearance.maxWidth} min={55} max={100} unit="％" onChange={value => patch({ maxWidth: value })} />
        <h4>文字</h4>
        <RangeSetting label="字体大小" value={appearance.fontSize} min={10} max={28} unit="px" onChange={value => patch({ fontSize: value })} />
        {colorSetting("textColor", "默认文字颜色")}
        {colorSetting("dialogueColor", "「」内文字颜色")}
        {colorSetting("boldColor", "加粗文字颜色")}
        {colorSetting("italicColor", "斜体／心声文字颜色")}
        <RangeSetting label="行间距" value={appearance.lineHeight} min={1.2} max={2.6} step={0.02} unit="倍" onChange={value => patch({ lineHeight: value })} />
        <label className="story-beautify-preset"><span>段落排版</span><select aria-label="段落排版" value={appearance.paragraphMode} onChange={event => patch({ paragraphMode: event.target.value as StoryBubbleAppearance["paragraphMode"] })}>
          <option value="default">默认</option><option value="indent">首行缩进</option><option value="center">全部居中</option><option value="indent-center">首行缩进＋居中</option>
        </select></label>
        <p>首行缩进为两个字，可与段落居中组合；和气泡位置分开控制。</p>
        <RangeSetting label="段落间距" value={appearance.paragraphGap} min={0} max={32} unit="px" onChange={value => patch({ paragraphGap: value })} />
        <h4>头像</h4>
        <label className="story-beautify-preset"><span>头像位置</span><select aria-label="头像位置" value={appearance.avatarLayout} onChange={event => patch({ avatarLayout: event.target.value as StoryBubbleAppearance["avatarLayout"] })}>
          <option value="default">默认位置</option><option value="center">气泡上方居中</option><option value="reverse">左右对调（角色右／用户左）</option>
        </select></label>
        <p>居中时，昵称和时间排列在头像下方。</p>
        <RangeSetting label="头像与气泡间距" value={appearance.avatarGap} min={0} max={64} unit="px" onChange={value => patch({ avatarGap: value })} />
        <label className="story-beautify-check"><input type="checkbox" aria-label="显示消息时间" checked={appearance.showTimestamp} onChange={event => patch({ showTimestamp: event.target.checked })} /><span>显示消息时间</span></label>
        <p>时间开启后，与头像、昵称作为一组跟随位置设置。</p>
        <RangeSetting label="头像大小" value={appearance.avatarSize} min={20} max={72} unit="px" onChange={value => patch({ avatarSize: value })} />
        <label className="story-beautify-preset"><span>头像形状</span><select aria-label="头像形状" value={appearance.avatarShape} onChange={event => patch({ avatarShape: event.target.value as StoryBubbleAppearance["avatarShape"] })}>
          <option value="square">方形</option><option value="rounded">圆角方形</option><option value="circle">圆形</option>
        </select></label>
        <button className="story-beautify-reset-side" type="button" onClick={() => { setNotice(""); setPrefs(previous => ({ ...previous, appearance: { ...previous.appearance,
          ...(role === "both" ? { user: undefined, assistant: undefined } : { [role]: undefined }),
        } })); }}>恢复{role === "both" ? "双方" : role === "user" ? "用户" : "角色"}默认样式</button>
        <h4>消息间距（双方共用）</h4>
        <RangeSetting label="消息间距" value={normalizeStoryMessageGap(prefs.appearance?.messageGap)} min={8} max={64} unit="px" onChange={value => { setNotice(""); setPrefs(previous => ({ ...previous, appearance: { ...previous.appearance, messageGap: value } })); }} />
      </section>}

      <section className="story-beautify-card">
        <h3>效果预览</h3>
        <div className={`story-beautify-preview ${previewId}`} {...storyChromeAttributes(prefs)} style={{ backgroundImage: prefs.wallpaper ? `url(${JSON.stringify(prefs.wallpaper)})` : undefined }}>
          <StoryAppearanceVariables prefs={prefs} scope={previewScope} />
          {css && <SessionCustomCSS css={css} scope={previewScope} priority />}
          {prefs.wallpaper && panelVisible && <div className="story-beautify-preview-shade" />}
          <div className="story-header story-beautify-preview-header" aria-hidden="true"><div className="story-header-content">
            <div className="story-header-left"><button type="button" tabIndex={-1} data-story-action="back" className="story-top-btn">‹</button><div className="story-header-person"><Avatar size="sm" name={characterName} src={characterAvatar} /><span>{characterName}</span></div></div>
            <div className="story-header-center" /><div className="story-header-right"><button type="button" tabIndex={-1} data-story-action="new" className="story-top-btn">＋</button><button type="button" tabIndex={-1} data-story-action="beautify" className="story-top-btn">✎</button><button type="button" tabIndex={-1} data-story-action="settings" className="story-top-btn">☰</button></div>
          </div></div>
          <div className={`story-stage-inner${storyStageAppearanceClass(prefs)}`}>
            {(["user", "assistant"] as const).map(speaker => <article key={speaker} className="story-row" data-role={speaker} {...storyMessageAppearanceAttributes(prefs, speaker)}>
              <div className="story-msg-head"><div className="story-avatar-wrap"><Avatar cssSized size="md" name={speaker === "user" ? userName : characterName} src={speaker === "user" ? userAvatar : characterAvatar} /></div>
                <div className="story-msg-meta"><span className="story-msg-name">{speaker === "user" ? userName : characterName}</span><span className="story-msg-time" data-story-timestamp="">12:30</span></div></div>
              <div className="story-bubble-wrap"><div className="story-bubble"><StoryHtmlRenderer colorDialogue={!panelVisible} messageId={`beauty-preview-${speaker}`} content={speaker === "user" ? "我抬起头望向你。\n\n「今天一起走走吧。」\n\n**这句话很重要。**\n\n*我也有些期待这次散步。*" : "我停下脚步，笑着回应。\n\n「好，我陪你。」\n\n**我记住了你的邀请。**\n\n*他悄悄期待着与你同行。*"} /></div></div>
            </article>)}
          </div>
          <div className="story-composer story-beautify-preview-composer" aria-hidden="true"><button type="button" tabIndex={-1} data-story-action="continue" className="story-continue-btn">续写</button><textarea tabIndex={-1} readOnly rows={1} value="输入消息…" /><button type="button" tabIndex={-1} data-story-action="send" data-state="idle" className="story-send-btn">↑</button></div>
        </div>
        <p>当前参数与高级 CSS 一起预览。基础美化保存并应用后生效，其余设置实时保存；选择预设后点击应用即可恢复整套美化。</p>
      </section>

      <section className="story-beautify-card story-beautify-saved-presets">
        <h3>美化预设</h3>
        <label className="story-beautify-preset"><span>选择预设</span><select aria-label="美化预设" value={selectedPreset ? selectedPresetId : ""} onChange={event => {
          const selected = presets.find(item => item.id === event.target.value);
          setSelectedPresetId(selected?.id || ""); setPresetName(selected?.name || ""); setDeletePending(false);
        }}><option value="">请选择预设</option>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="story-beautify-preset story-beautify-preset-name"><span>预设名称</span><input aria-label="美化预设名称" value={presetName} maxLength={60} placeholder="给这套美化起个名字" onChange={event => { setPresetName(event.target.value); setDeletePending(false); }} /></label>
        <div className="story-beautify-actions">
          <button type="button" disabled={!presetName.trim()} onClick={() => savePreset()}>保存为新预设</button>
          <button type="button" disabled={!selectedPreset} onClick={applyPreset}>应用预设</button>
          <button type="button" disabled={!selectedPreset || !presetName.trim()} onClick={() => {
            if (renameStoryAppearancePreset(selectedPresetId, presetName)) { setPresets(getStoryAppearancePresets()); setPresetName(presetName.trim().slice(0, 60)); setNotice("预设已改名。"); }
          }}>保存名称</button>
          <button type="button" disabled={!selectedPreset || !presetName.trim()} onClick={() => savePreset(true)}>更新为当前参数</button>
          <button type="button" disabled={!selectedPreset} onClick={() => setDeletePending(true)}>删除预设</button>
        </div>
        {deletePending && selectedPreset && <div className="story-beautify-actions story-beautify-preset-confirm"><span>删除「{selectedPreset.name}」？</span>
          <button type="button" onClick={() => { deleteStoryAppearancePreset(selectedPresetId); setPresets(getStoryAppearancePresets()); setSelectedPresetId(""); setPresetName(""); setDeletePending(false); setNotice("预设已删除，当前美化保留。"); }}>确认删除预设</button>
          <button type="button" onClick={() => setDeletePending(false)}>取消删除</button></div>}
        <p>保存当前预览中的壁纸、主题、阅读面板、双方参数、两栏设置、CSS 和美化方式。仅改名不改变预设内容；更新参数后可再次应用。</p>
      </section>

      <details className="story-beautify-card story-beautify-css" open={cssOpen} onToggle={event => setCSSOpen(event.currentTarget.open)}><summary>高级自定义 CSS</summary>
        <textarea aria-label="剧情自定义 CSS" className="story-css-box" value={css} onChange={event => applyCSS(event.target.value)} placeholder="在这里输入剧情页面 CSS" />
        <div className="story-beautify-actions"><CSSSchemeBar target="story" currentCSS={css} onLoad={applyCSS} />
          <button type="button" onClick={() => applyCSS(STORY_CSS_EXAMPLE)}>加载白色基础模板</button><button type="button" onClick={() => applyCSS("")}>清除 CSS</button></div>
      </details>
      <p className="story-beautify-notice" role="status">{wallpaperLoading ? "正在读取壁纸…" : notice || "壁纸、阅读面板、主题、两栏设置和 CSS 修改后立即保存，关闭美化不会撤销。"}</p>
    </main>
    {!panelVisible && basicEnabled && <footer><button type="button" onClick={() => { setPrefs(previous => ({ ...previous, appearance: undefined })); setNotice("基础美化已重置，保存并应用后生效。"); }}>重置基础美化</button>
      <button type="button" className="story-beautify-save" onClick={() => { onApplyAppearance(prefs.appearance); appliedAppearanceRef.current = prefs.appearance; progressRef.current.draft = undefined; saveProgress(); setNotice("基础美化已保存并应用，可继续调整。"); }}>保存并应用</button></footer>}
  </div>;
  return portalHost ? createPortal(editor, portalHost) : editor;
}
