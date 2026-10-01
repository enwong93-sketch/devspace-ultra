import { verifiedLocalProviderBinding } from './openai-conversation-binding.js';

// The claim registry has already validated and normalized the exact local page
// receipt. Bind the authenticated identity before creating any durable Goal/Plan;
// a failed binding must not leave an orphan active objective behind.
export async function completeConversationStart({
  claimId, input, authority, toolName, providerIdentity,
  openaiBindings, goalRuntime, planRuntime,
}) {
  if (!['devspace_goal_start', 'devspace_plan_start'].includes(toolName)) {
    throw new Error(`Unsupported conversation start claim tool ${toolName}.`);
  }
  if (providerIdentity) {
    const bound = await openaiBindings?.bind?.(providerIdentity, authority, {
      conversationStartClaimId: claimId,
      currentInvocation: authority?.currentInvocationVerified === true,
    });
    if (!bound?.bound) {
      throw new Error('The provider conversation could not be attached through its exact local start claim.');
    }
    const verified = await openaiBindings.resolve(providerIdentity);
    if (!verifiedLocalProviderBinding(verified, providerIdentity)
      || verified.conversationId !== authority.conversationId) {
      throw new Error('The exact local provider binding did not survive live page verification.');
    }
  }
  if (toolName === 'devspace_goal_start') {
    const started = await goalRuntime.startOrResume({
      objective: input.objective, successCriteria: input.successCriteria,
      conversationId: authority.conversationId,
    });
    return { goal: started.goal, resumed: started.resumed };
  }
  const started = await planRuntime.startOrResume({
    title: input.title, steps: input.steps, conversationId: authority.conversationId,
  });
  return { plan: started.plan, resumed: started.resumed };
}
