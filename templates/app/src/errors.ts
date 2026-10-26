/** An error with an HTTP status. The kit error handler keeps 4xx messages and hides 5xx ones. */
export class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
