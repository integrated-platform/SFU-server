import express from 'express';
import dotenv from 'dotenv';
import * as mediasoup from 'mediasoup';
import { Kafka } from 'kafkajs';

dotenv.config();
const app = express();
app.use(express.json());

/**
 * mediasoup Worker 생성
 */
let worker: mediasoup.types.Worker;
const mediasoupOptions = {
  rtcMinPort: Number(process.env.RTC_MIN_PORT) || 40000,
  rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 40100,
  logLevel: 'warn',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
};

(async () => {
  try {
    worker = await mediasoup.createWorker(mediasoupOptions);
    worker.on('died', () => {
      console.error('mediasoup worker died, exiting process...');
      process.exit(1);
    });
    console.log('mediasoup worker created');
  } catch (error) {
    console.error('Worker 생성 오류:', error);
  }
})();

// 각 방에 대한 Router 및 관련 데이터 저장
const rooms: {
  [roomId: string]: { router: mediasoup.types.Router; transports: Map<string, mediasoup.types.WebRtcTransport> }
} = {};

// Kafka 설정
const kafka = new Kafka({
  clientId: 'sfu-server',
  brokers: process.env.KAFKA_BROKERS
    ? process.env.KAFKA_BROKERS.split(',')
    : ['localhost:9092'],
});
const kafkaProducer = kafka.producer();
const kafkaConsumer = kafka.consumer({ groupId: 'sfu-group' });

(async () => {
  await kafkaProducer.connect();
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topic: 'sfu_commands', fromBeginning: true });
  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) {
        const command = JSON.parse(message.value.toString());
        console.log('수신된 명령:', command);
        if (command.type === 'join-room') {
          const roomId = command.room;
          // 해당 방이 없으면 mediasoup Router 생성
          if (!rooms[roomId]) {
            try {
              const mediaCodecs = [
                {
                  kind: 'audio',
                  mimeType: 'audio/opus',
                  clockRate: 48000,
                  channels: 2,
                },
                {
                  kind: 'video',
                  mimeType: 'video/VP8',
                  clockRate: 90000,
                  parameters: { 'x-google-start-bitrate': 1000 },
                },
              ];
              const router = await worker.createRouter({ mediaCodecs });
              rooms[roomId] = { router, transports: new Map() };
              console.log(`Room ${roomId} 생성됨`);
            } catch (error) {
              console.error('Router 생성 오류:', error);
            }
          }
          // join-room 명령 처리 후, signaling 업데이트 전송 (예: RTP capabilities)
          const update = {
            event: 'room-joined',
            room: roomId,
            payload: {
              routerRtpCapabilities: rooms[roomId].router.rtpCapabilities,
            },
          };
          await kafkaProducer.send({
            topic: 'signaling_updates',
            messages: [{ value: JSON.stringify(update) }],
          });
        } else if (command.type === 'disconnect') {
          console.log(`Socket ${command.socketId} disconnect 명령 수신`);
          // 추가 disconnect 처리 가능
        }
      }
    },
  });
  console.log('Kafka consumer running in SFU 서버');
})();

const PORT = process.env.SFU_PORT || 5000;
app.listen(PORT, () => {
  console.log(`SFU 서버가 포트 ${PORT}에서 실행 중`);
});
