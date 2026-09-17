import test from 'node:test';
import assert from 'node:assert/strict';
import { QUIZ_TOOL_NAME, buildQuizRequest, gradeQuizCompletion, runModelQuiz } from '../services/modelQuiz.ts';
import { extractProviderMessage } from '../services/gemini.ts';

const perfectArgs = { arithmetic: '379', brick: '2 kg', code: '9', count: '6', reverse: 'EGDIRB' };

function toolCompletion(args: unknown, name = QUIZ_TOOL_NAME) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { total_tokens: 321 }
  };
}

test('quiz: request has one required tool with all answer fields', () => {
  const body = buildQuizRequest('gemini-3.6-flash');
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.tools[0].function.name, QUIZ_TOOL_NAME);
  assert.deepEqual(body.tools[0].function.parameters.required, ['arithmetic', 'brick', 'code', 'count', 'reverse']);
  assert.match(body.messages[0].content, /strawberry raspberry/);
});

test('quiz: perfect tool call scores 6/6 (numbers tolerate units)', () => {
  const grade = gradeQuizCompletion(toolCompletion(perfectArgs));
  assert.equal(grade.score, 6);
  assert.equal(grade.total, 6);
  assert.equal(grade.toolCall, true);
});

test('quiz: wrong answers are reported with got/expected', () => {
  const grade = gradeQuizCompletion(toolCompletion({ ...perfectArgs, count: '5', reverse: 'egdirb' }));
  assert.equal(grade.score, 4);
  const misses = grade.checks.filter((c) => !c.pass).map((c) => [c.id, c.got, c.expected]);
  assert.deepEqual(misses, [['count', '5', '6'], ['reverse', 'egdirb', 'EGDIRB']]);
});

test('quiz: JSON answered as text still graded, but tool_call fails', () => {
  const grade = gradeQuizCompletion({ choices: [{ message: { content: '```json\n' + JSON.stringify(perfectArgs) + '\n```' } }] });
  assert.equal(grade.toolCall, false);
  assert.equal(grade.score, 5);
});

test('quiz: garbage reply scores 0 without throwing', () => {
  const grade = gradeQuizCompletion({ choices: [{ message: { content: 'I cannot help with that.' } }] });
  assert.equal(grade.score, 0);
});

test('quiz: falls back to tool_choice auto when required is rejected', async () => {
  const choices: unknown[] = [];
  const outcome = await runModelQuiz('gemini-x', async (body) => {
    choices.push(body.tool_choice);
    if (body.tool_choice === 'required') {
      return new Response(JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value for tool_choice' } }]), { status: 400 });
    }
    return new Response(JSON.stringify(toolCompletion(perfectArgs)), { status: 200 });
  }, extractProviderMessage);
  assert.deepEqual(choices, ['required', 'auto']);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.score, 6);
    assert.equal(outcome.totalTokens, 321);
  }
});

test('quiz: upstream error surfaces provider message', async () => {
  const outcome = await runModelQuiz('gemini-x', async () =>
    new Response(JSON.stringify([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'limit: 0' } }]), { status: 429 }), extractProviderMessage);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, 'HTTP 429 - RESOURCE_EXHAUSTED: limit: 0');
});
