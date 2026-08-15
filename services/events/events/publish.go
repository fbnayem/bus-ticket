package events

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is the one method a producer needs to publish. Both pgx.Tx and
// *pgxpool.Pool satisfy it, so a caller whose state change is a single
// statement can pass the pool and still be writing inside one transaction.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Publish writes an event into a producer's own outbox, inside whatever
// transaction the caller is already in.
//
// This is the only sanctioned way to emit an event, and it takes the caller's
// transaction on purpose. An event that becomes durable separately from the
// state change it describes is exactly the dual-write bug the outbox pattern
// exists to prevent; making the transaction an argument is what stops that from
// happening by accident.
func Publish(ctx context.Context, tx Execer, outboxTable, aggregateID, eventType string, payload any) error {
	if !identSafe.MatchString(outboxTable) {
		return fmt.Errorf("events: %q is not a valid outbox table", outboxTable)
	}
	blob, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	q := fmt.Sprintf(
		`INSERT INTO %s (aggregate_id, event_type, payload) VALUES ($1::uuid, $2, $3)`, outboxTable)
	_, err = tx.Exec(ctx, q, aggregateID, eventType, blob)
	return err
}
