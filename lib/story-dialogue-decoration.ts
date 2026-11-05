/** Decorate text nodes only; never rewrite HTML attributes, code or voice buttons. */
export function decorateStoryDialogue(root: HTMLElement): void {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let inDialogue = false;
  let block: Element | null = null;
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,textarea,pre,code,button,.story-dialogue,.story-voice-segment")) continue;
    const currentBlock = parent.closest("p,div,li,td,th,blockquote,h1,h2,h3,h4,h5,h6");
    if (block !== currentBlock) { inDialogue = false; block = currentBlock; }
    const text = node.textContent || "";
    if (!inDialogue && !text.includes("「")) continue;
    const fragment = document.createDocumentFragment();
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      if (inDialogue) {
        const span = document.createElement("span");
        span.className = "story-dialogue";
        span.setAttribute("data-story-dialogue-decoration", "");
        span.textContent = buffer;
        fragment.append(span);
      } else fragment.append(document.createTextNode(buffer));
      buffer = "";
    };
    for (const char of text) {
      if (char === "「" && !inDialogue) { flush(); inDialogue = true; }
      buffer += char;
      if (char === "」" && inDialogue) { flush(); inDialogue = false; }
    }
    flush();
    node.replaceWith(fragment);
  }
}

export function clearStoryDialogueDecoration(root: HTMLElement): void {
  const spans = root.querySelectorAll("[data-story-dialogue-decoration]");
  if (!spans.length) return;
  spans.forEach(span => span.replaceWith(...Array.from(span.childNodes)));
  root.normalize();
}
