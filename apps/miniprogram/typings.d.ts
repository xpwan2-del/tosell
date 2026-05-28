declare const wx: {
  login(input: {
    success(result: { code?: string }): void;
    fail?(error: { errMsg: string }): void;
  }): void;
  request<T = unknown>(input: {
    url: string;
    method?: "GET" | "POST" | "PATCH";
    header?: Record<string, string>;
    data?: unknown;
    success(result: { statusCode: number; data: T }): void;
    fail?(error: { errMsg: string }): void;
  }): void;
  setClipboardData(input: { data: string }): void;
  navigateTo(input: { url: string }): void;
  showToast(input: { title: string; icon?: string }): void;
};

declare function App(config: Record<string, unknown>): void;
declare function Page(config: Record<string, unknown>): void;
declare function getApp<T = Record<string, unknown>>(): T;

declare namespace WechatMiniprogram {
  type TouchEvent = {
    currentTarget: {
      dataset: Record<string, string>;
    };
  };
  type InputEvent = {
    detail: {
      value: string;
    };
  };
}
