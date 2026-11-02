// The slice of Pi's host packages this extension touches. Pi supplies the
// real modules at load; these declarations let the repo type-check without
// installing them.

declare module '@earendil-works/pi-tui' {
  export function getCellDimensions(): { widthPx: number; heightPx: number }
}

declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionContext {
    ui: {
      notify(message: string, type?: 'info' | 'warning' | 'error'): void
      theme: { getBgAnsi(color: string): string }
      setWidget?(
        key: string,
        factory: (tui: { invalidate(): void; requestRender(force?: boolean): void }) => {
          render(width: number): string[]
          invalidate(): void
        },
      ): void
    }
  }
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void
    registerMarkdownTransformer(
      fn: (markdown: string, ctx: { messageType: 'user' | 'assistant' | 'assistant-thinking'; isStreaming: boolean; availableWidth: number }) => string,
    ): void
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
    ): void
  }
}
