import request from 'supertest';
import express, { Express } from 'express';
import cors from 'cors';

describe('Express App', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(cors()); // Allow all origins for testing
    app.get('/', (req, res) => {
      res.status(200).send('Hello World!');
    });
  });

  it('should return 200 and "Hello World!" for GET /', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toEqual('Hello World!');
  });
});
