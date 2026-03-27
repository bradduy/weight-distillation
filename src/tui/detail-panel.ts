export class DetailPanel {
  private box: any;  // blessed.Element
  private current: any | null = null;
  private showBody = false;

  constructor(box: any) {
    this.box = box;
  }

  setTransaction(tx: any | null): void {
    this.current = tx;
    this.showBody = false;
    this.render();
  }

  toggleBody(): void {
    this.showBody = !this.showBody;
    this.render();
  }

  private render(): void {
    if (!this.current) {
      this.box.setContent("Select a request to view details");
      return;
    }
    const tx = this.current;
    const reqHdrs = Object.entries(tx.reqHeaders ?? {})
      .map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
    const resHdrs = Object.entries(tx.resHeaders ?? {})
      .map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";

    let bodyContent = "(empty)";
    if (this.showBody && tx.resBody !== null) {
      if (tx.resBodyPreview !== null) {
        bodyContent = this.formatJson(tx.resBodyPreview);
      } else if (tx.resBodyEncoding === "base64") {
        bodyContent = "[binary body — base64]\n" + tx.resBody;
      } else {
        bodyContent = tx.resBody;
      }
    } else if (this.showBody) {
      bodyContent = "(no response body)";
    }

    const errorLine = tx.error ? `\nERROR: ${tx.error}` : "";
    const bodyToggle = this.showBody ? " [press Enter to hide]" : " [press Enter to show]";

    // AI distillation section
    let aiSection = "";
    if (tx.aiProvider) {
      const tokens = tx.aiTotalTokens != null
        ? `  Tokens: ${tx.aiTotalTokens.toLocaleString()} (${tx.aiPromptTokens?.toLocaleString() ?? "?"} prompt + ${tx.aiCompletionTokens?.toLocaleString() ?? "?"} completion)`
        : "";
      const cost = tx.aiEstimatedCostUsd != null
        ? `  Est. cost: $${tx.aiEstimatedCostUsd}`
        : "";
      const modelLine = tx.aiModel ? `  Model: ${tx.aiModel}` : "";
      aiSection = [
        "",
        "── AI Distillation ──",
        `  Provider: ${tx.aiProvider}${modelLine}${tokens}${cost}`,
      ].join("\n");
      if (tx.aiParsedResponse) {
        const pr = tx.aiParsedResponse;
        const mathLine = pr.mathAnswer != null ? `  Math answer: \\boxed{${pr.mathAnswer}}` : "";
        const toolLine = pr.toolCalls?.length
          ? `  Tool calls: ${pr.toolCalls.map((t: any) => t.name).join(", ")}`
          : "";
        const codeBlockCount = pr.codeBlocks?.length ?? 0;
        const codeLine = codeBlockCount > 0
          ? `  Code blocks: ${codeBlockCount} (${pr.codeBlocks!.map((b: any) => b.language).join(", ")})`
          : "";
        const finishLine = pr.finishReason ? `  Finish: ${pr.finishReason}` : "";
        aiSection += `\n${mathLine}${toolLine}${codeLine}${finishLine}`.trim();
      }
      if (tx.aiConversationId) aiSection += `\n  Session: ${tx.aiConversationId}`;
    }

    const content = [
      `#${String(tx.id).slice(0, 8)}  ${tx.method}  ${tx.url}`,
      "",
      "Request Headers:",
      reqHdrs,
      "",
      "Response Headers:",
      resHdrs,
      "",
      `Status: ${tx.statusCode}  Duration: ${tx.durationMs}ms${errorLine}`,
      `${aiSection}`,
      "",
      `Response Body:${bodyToggle}`,
      bodyContent,
    ].join("\n");

    this.box.setContent(content);
  }

  private formatJson(str: string): string {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return str;
    }
  }
}
