import axios from 'axios';

const BASE_URL = 'http://127.0.0.1:4094';

async function testHealth() {
  console.log('\n=== 测试健康检查 ===');
  try {
    const response = await axios.get(`${BASE_URL}/health`);
    console.log('✅ 健康检查通过:', response.data);
    return true;
  } catch (error: any) {
    console.error('❌ 健康检查失败:', error.message);
    return false;
  }
}

async function testListModels() {
  console.log('\n=== 测试模型列表 ===');
  try {
    const response = await axios.get(`${BASE_URL}/v1/models`);
    console.log(`✅ 获取到 ${response.data.data.length} 个模型`);
    console.log('前 5 个模型:', response.data.data.slice(0, 5).map((m: any) => m.id));
    return true;
  } catch (error: any) {
    console.error('❌ 获取模型列表失败:', error.message);
    return false;
  }
}

async function testChatCompletion() {
  console.log('\n=== 测试对话补全 ===');
  try {
    const response = await axios.post(`${BASE_URL}/v1/chat/completions`, {
      model: 'opencode/gpt-5-nano',
      messages: [
        { role: 'user', content: '你好，请用一句话介绍你自己' }
      ],
      temperature: 0.7
    });
    console.log('✅ 对话补全成功');
    console.log('回复:', response.data.choices[0].message.content.substring(0, 100) + '...');
    return true;
  } catch (error: any) {
    console.error('❌ 对话补全失败:', error.message);
    return false;
  }
}

async function testStreamChatCompletion() {
  console.log('\n=== 测试流式对话补全 ===');
  try {
    const response = await axios.post(`${BASE_URL}/v1/chat/completions`, {
      model: 'opencode/gpt-5-nano',
      messages: [
        { role: 'user', content: '你好' }
      ],
      temperature: 0.7,
      stream: true
    }, {
      responseType: 'stream'
    });

    let chunkCount = 0;
    let fullText = '';

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              console.log(`✅ 流式补全完成，共 ${chunkCount} 个数据块`);
              console.log('完整回复:', fullText.substring(0, 100) + '...');
              resolve(true);
              return;
            }
            try {
              const json = JSON.parse(data);
              if (json.choices && json.choices[0]?.delta?.content) {
                fullText += json.choices[0].delta.content;
                chunkCount++;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      });

      response.data.on('end', () => {
        if (chunkCount > 0) {
          console.log(`✅ 流式补全完成，共 ${chunkCount} 个数据块`);
          resolve(true);
        } else {
          reject(new Error('未接收到任何数据块'));
        }
      });

      response.data.on('error', (error: Error) => {
        reject(error);
      });
    });
  } catch (error: any) {
    console.error('❌ 流式对话补全失败:', error.message);
    return false;
  }
}

async function testCompletion() {
  console.log('\n=== 测试文本补全 ===');
  try {
    const response = await axios.post(`${BASE_URL}/v1/completions`, {
      model: 'opencode/gpt-5-nano',
      prompt: '你好，请用一句话介绍你自己',
      temperature: 0.7
    });
    console.log('✅ 文本补全成功');
    console.log('回复:', response.data.choices[0].text.substring(0, 100) + '...');
    return true;
  } catch (error: any) {
    console.error('❌ 文本补全失败:', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('开始测试 OpenAI 兼容 API 服务器');
  console.log('='.repeat(60));

  const results = {
    health: await testHealth(),
    listModels: await testListModels(),
    chatCompletion: await testChatCompletion(),
    streamChatCompletion: await testStreamChatCompletion(),
    completion: await testCompletion()
  };

  console.log('\n' + '='.repeat(60));
  console.log('测试结果汇总');
  console.log('='.repeat(60));
  console.log(`健康检查: ${results.health ? '✅ 通过' : '❌ 失败'}`);
  console.log(`模型列表: ${results.listModels ? '✅ 通过' : '❌ 失败'}`);
  console.log(`对话补全: ${results.chatCompletion ? '✅ 通过' : '❌ 失败'}`);
  console.log(`流式补全: ${results.streamChatCompletion ? '✅ 通过' : '❌ 失败'}`);
  console.log(`文本补全: ${results.completion ? '✅ 通过' : '❌ 失败'}`);
  console.log('='.repeat(60));

  const allPassed = Object.values(results).every(r => r === true);
  console.log(`\n总体结果: ${allPassed ? '✅ 所有测试通过' : '❌ 部分测试失败'}`);
  console.log('='.repeat(60));

  process.exit(allPassed ? 0 : 1);
}

runAllTests();
