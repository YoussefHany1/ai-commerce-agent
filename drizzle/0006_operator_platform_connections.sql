-- platform_connections shipped with only the app.store_id isolation policy and no
-- tenant_operator_* counterpart, unlike all 15 sibling tenant tables. Because
-- withOperator() sets only app.operator (never app.store_id), the sole policy's
-- predicate evaluated to NULL and every operator query saw zero rows. Two
-- consequences: connectionRepo.listDue() always returned [], so the catalog-sync
-- worker never enqueued a job; and storeRepo.remove() deleted the stores row
-- while its platform_connections row survived, orphaning access_token_enc /
-- refresh_token_enc on uninstall (src/lib/webhookApply.ts app/uninstalled).
CREATE POLICY "tenant_operator_platform_connections" ON "platform_connections"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
