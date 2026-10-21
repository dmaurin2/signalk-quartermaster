# Optional AI access

Manual equipment documentation works without AI.

## Hosted trial

The initial trial is invite-based. Contact Open Ocean OS through the project website to request access. Automatic signup, payment and token delivery are not included.

The operator supplies a unique private token and the trial service HTTPS URL. Set `QUARTERMASTER_TRIAL_TOKEN` in the Signal K service environment, choose `trial` in Plugin Config and enter the supplied URL. Restart the service after changing its environment. Keep credentials out of the repository, browser screenshots and support messages.

A new account includes five successful identifications. Live testing confirmed that the sixth new identification is blocked. Equipment records and manual entry remain available afterward.

The service is designed to return a cached result for an unchanged request and release credits after failed requests. These behaviors have automated coverage; live verification remains pending. Additional safety limits can stop attempts before successful credits are exhausted.

## Direct owner key

Set `OPENAI_API_KEY` and explicitly set `OPENAI_MODEL` in the Signal K service environment. The model must be available to your account and support images and structured results. Direct usage is billed to your OpenAI API account separately from ChatGPT.

Do not rely on the candidate's legacy default model name. The hosted pilot used `gpt-5-mini`; validate the selected model for your own deployment.

Never put an API key in plugin source, a GitHub file or a distributable system image.

## Photographs and privacy

Review photographs for personal information before submitting them.

- Direct mode sends selected photographs to OpenAI.
- Trial mode sends them to the Open Ocean OS trial service and OpenAI.
- The trial service persists extracted results for retry recovery and account counters, rather than saving uploaded photo files.
- OpenAI's handling and retention depend on the applicable account settings and terms.

The equipment database, stored photographs and manuals remain on the Signal K host. AI proposals require human review before approval.
