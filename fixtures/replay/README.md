# REPLAY fixtures

market-spec.json 是保留的v0.1 reader測試資料，使用不存在公司與example.com；已過期，不可建LIVE。

M1的pnpm replay會以此為模板產生v0.1.1、新的相對時間與各場specHash，在自己啟動的Anvil完成normal/dispute/timeout三條流程。生成的精確spec bytes與report位於contracts/artifacts，皆為REPLAY / LOCAL_REPLAY_ONLY。

這是合約層與M0 schema的整合，尚未經過API、Indexer或LLM；不宣称已有事前預測或外部Alpha部署。
