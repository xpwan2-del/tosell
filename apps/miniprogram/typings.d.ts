declare const wx: {
  setClipboardData(input: { data: string }): void;
  navigateTo(input: { url: string }): void;
  showToast(input: { title: string; icon?: string }): void;
};

declare function App(config: Record<string, unknown>): void;
declare function Page(config: Record<string, unknown>): void;

declare namespace WechatMiniprogram {
  type TouchEvent = {
    currentTarget: {
      dataset: Record<string, string>;
    };
  };
}
