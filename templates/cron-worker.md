## This task is a scheduled job

Sous chef's cron job `{{job}}` launched this session on its schedule. Nobody asked for this run by hand, so only report what is worth {{owner}}'s attention.

- If you found something worth reporting, finish with `sc report done "<what you found>"` as usual.
- If you found nothing worth reporting, finish with `sc report nothing-new "<one line on what you checked>"` instead. That does not wake sous chef, and this session is archived automatically afterwards.
- Questions, blockers and failures are reported as usual (`needs-decision`, `blocked`, `failed`); they always reach sous chef.
- If the job comes due again while you are still working, the next run arrives as a message in your inbox rather than as a new session. Finish the current run first.
