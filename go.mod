module github.com/busticket/platform

// 1.24 is the floor because staff-service hashes passwords with the standard
// library's crypto/pbkdf2, added in that release. Rolling our own PBKDF2 or
// pulling in a dependency to hash passwords would both be worse trades.
go 1.24

require github.com/jackc/pgx/v5 v5.7.2

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)
