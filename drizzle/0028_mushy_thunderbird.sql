CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_status_created_idx" ON "outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_window_idx" ON "rate_limits" USING btree ("window_start");