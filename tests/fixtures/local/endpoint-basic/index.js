// Default export, manifest `type: "endpoint"` -> mounted in Phase 2 under `/endpoint-basic`.
export default function endpointBasic(router, context) {
	router.get('/ping', async () => {
		return { ok: true, id: context.id };
	});
}
