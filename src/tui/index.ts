import * as blessed from "blessed";
import type { TrafficAnalyzer } from "../analyzer/index.js";
import { RequestList } from "./request-list.js";
import { DetailPanel } from "./detail-panel.js";

export async function runTUI(analyzer: TrafficAnalyzer, address: string): Promise<void> {
  const screen = blessed.screen({ smartCSR: true });

  // Top bar
  blessed.box({
    parent: screen, top: 0, left: 0, right: 0, height: 1,
    content: ` weight-distillation  ${address}`,
    style: { fg: "white", bg: "blue" },
  });

  // Request list
  const listContainer = blessed.box({
    parent: screen, top: 1, left: 0, right: 0, height: 10,
    border: { type: "line" }, label: " Requests ",
  });

  const detailContainer = blessed.box({
    parent: screen, top: 12, left: 0, right: 0, bottom: 2,
    border: { type: "line" }, label: " Detail ",
    scrollable: true, alwaysScroll: true,
  });

  // Stats bar
  const statsBar = blessed.box({
    parent: screen, bottom: 1, left: 0, right: 0, height: 1,
    content: " Errors: 0  Total: 0  p50: --ms  p95: --ms  AI: 0 calls  $0.00",
    style: { fg: "green" },
  });

  // Hint bar
  blessed.box({
    parent: screen, bottom: 0, left: 0, right: 0, height: 1,
    content: " ↑↓ navigate  Enter body  c clear  q quit",
    style: { fg: "black", bg: "gray" },
  });

  const detailPanel = new DetailPanel(detailContainer);
  const requestList = new RequestList({
    parent: listContainer,
    analyser: analyzer,
    onSelect: (tx) => detailPanel.setTransaction(tx),
  });

  // Wire events
  (analyzer as any).on("transactionAdded", ({ transaction }: any) => {
    requestList.addItem(transaction);
    const stats = analyzer.getStats();
    statsBar.setContent(
      ` Errors: ${stats.errors}  Total: ${stats.total}  p50: ${stats.latencyP50ms}ms  p95: ${stats.latencyP95ms}ms  AI: ${stats.aiCalls} calls  $${stats.aiEstimatedCostUsd.toFixed(4)}  ${stats.aiTotalTokens.toLocaleString()} tokens`,
    );
    screen.render();
  });

  // Keyboard bindings
  screen.key(["up", "k"], () => { requestList.selectPrev(); screen.render(); });
  screen.key(["down", "j"], () => { requestList.selectNext(); screen.render(); });
  screen.key(["enter"], () => { detailPanel.toggleBody(); screen.render(); });
  screen.key(["c"], () => { requestList.clear(); detailPanel.setTransaction(null); screen.render(); });
  screen.key(["q"], () => { screen.destroy(); process.exit(0); });

  screen.render();
}
