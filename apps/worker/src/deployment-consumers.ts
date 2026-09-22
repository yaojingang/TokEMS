type DeploymentConsumer = {
  resume(): Promise<void>;
  isRunning(): boolean;
  isPaused(): boolean;
};

export async function activateDeploymentConsumers(consumers: DeploymentConsumer[]) {
  // BullMQ resume() starts a stopped consumer itself; a second run() races it.
  await Promise.all(consumers.map((consumer) => consumer.resume()));
  if (consumers.some((consumer) => !consumer.isRunning() || consumer.isPaused())) {
    throw new Error('Worker consumers did not enter the running state');
  }
}
