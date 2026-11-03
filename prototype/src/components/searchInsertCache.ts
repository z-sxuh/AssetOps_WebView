export class SearchInsertCache {
  private request = -1;
  private results = new Map<string, Promise<string | undefined>>();
  clear() { this.results.clear(); this.request = -1; }
  run(request: number, token: string, statusOnly: boolean, insert: () => Promise<void>) {
    if (this.request !== request) { this.clear(); this.request = request; }
    let result = this.results.get(token);
    if (!result) {
      if (statusOnly) return Promise.resolve('原保存状态未知，请到工作记录核对，勿重复提交');
      result = Promise.resolve().then(insert).then(() => undefined, reason => reason instanceof Error ? reason.message : String(reason));
      this.results.set(token, result);
    }
    return result;
  }
}
